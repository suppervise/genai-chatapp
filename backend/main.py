import os
import json
import io
from fastapi import FastAPI, HTTPException, File, UploadFile, Form
from pydantic import BaseModel
from dotenv import load_dotenv
from google import genai
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from typing import AsyncGenerator, List, Dict, Optional
from PIL import Image

from tavily import TavilyClient
from google.generativeai.types import Tool

from langchain_google_genai import GoogleGenerativeAIEmbeddings, ChatGoogleGenerativeAI

from langchain.text_splitter import RecursiveCharacterTextSplitter

from langchain.prompts import PromptTemplate
from langchain.schema.runnable import RunnablePassthrough
from langchain.schema.output_parser import StrOutputParser
import tempfile

from langchain_community.document_loaders import PyPDFLoader
from langchain_community.vectorstores import Chroma


# --- การติดตั้งที่จำเป็น ---
# pip install python-multipart Pillow google-generativeai
# หลังจากติดตั้งแล้ว, อย่าลืมอัปเดต requirements.txt:
# pip freeze > requirements.txt
# -------------------------

# โหลดตัวแปร environment จากไฟล์ .env
load_dotenv()
API_KEY = os.getenv("GEMINI_API_KEY")
if not API_KEY:
    raise RuntimeError("GEMINI_API_KEY environment variable not set. Please create a .env file.")

TAVILY_API_KEY = os.getenv("TAVILY_API_KEY") # <-- ดึง Tavily Key

# สร้าง client สำหรับ Google GenAI SDK
client = genai.Client(api_key=API_KEY)
tavily_client = TavilyClient(api_key=TAVILY_API_KEY) # <-- สร้าง Tavily Client

# สร้าง FastAPI app
app = FastAPI(title="GenAI Chat App API", version="1.1.0")



# ตั้งค่า CORS Middleware



allowed_origins_regex = r"https?:\/\/localhost:5173|https?:\/\/genai-chatapp(-[a-zA-Z0-9]+)?-boondees-projects\.vercel\.app"


app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=allowed_origins_regex, # <--- ใช้ Regex แทน list
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
# --- Pydantic Models ---
class AgenticRequest(BaseModel):
    history: List[Dict[str, str]]
    prompt: str
    model: str

# --- นิยาม "เครื่องมือค้นหา" (เหมือนเดิม แต่สำคัญมาก) ---
def tavily_search(query: str) -> str:
    """
    เครื่องมือสำหรับค้นหาข้อมูลล่าสุดจากอินเทอร์เน็ตเพื่อตอบคำถามเกี่ยวกับเหตุการณ์ปัจจุบัน
    และข้อมูลที่ไม่แน่นอน ใช้อันนี้เมื่อต้องการข้อมูลที่ up-to-date.
    """
    print(f"--- Calling Tavily Search Tool with query: '{query}' ---")
    try:
        # ใช้ search แทน basic_search หรือ advanced_search เพื่อความยืดหยุ่น
        response = tavily_client.search(query=query, search_depth="basic", max_results=5)
        context = "\n\n".join([f"Source URL: {obj['url']}\nContent: {obj['content']}" for obj in response['results']])
        return context
    except Exception as e:
        print(f"--- Tavily Search Error: {e} ---")
        return f"Error occurred during search: {e}"


@app.get("/")
def read_root():
    return {"status": "GenAI Chat App Backend is running!"}

@app.get("/api/health")
def health_check():
    return {"status": "ok", "message": "Backend is running correctly!"}

@app.get("/api/get-prompts")
async def get_prompts():
    """
    Endpoint สำหรับดึงข้อมูลคลังพร้อมท์จากไฟล์ prompts.json
    """
    try:
        with open("prompts.json", "r", encoding="utf-8") as f:
            prompts = json.load(f)
        return prompts
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Prompts file not found.")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error reading prompts file: {e}")


async def stream_generator(history: List[Dict[str, str]], prompt: str, model_name: str, image_bytes: Optional[bytes] = None) -> AsyncGenerator[str, None]:
    """
    ฟังก์ชันหลักที่สร้างคำตอบจาก AI แบบ Stream
    รองรับประวัติการสนทนา, ข้อความ, และรูปภาพ (ถ้ามี)
    """
    try:
        # --- จุดแก้ไขสำคัญ: การสร้าง `contents` สำหรับ Gemini API ---

        # 1. แปลง history (ที่เป็น text-only) ให้อยู่ในรูปแบบที่ Gemini เข้าใจ
        contents = []
        for message in history:
            # ข้ามข้อความที่เป็นเพียงตัวบอกว่ามีการแนบไฟล์ เพื่อไม่ให้ AI สับสน
            if "[Image Attached]" in message["text"]:
                continue
            
            role = "user" if message["sender"] == "user" else "model"
            contents.append({'role': role, 'parts': [{'text': message["text"]}]})

        # 2. เตรียม 'final_prompt_parts' สำหรับคำสั่งล่าสุดที่ผู้ใช้ส่งมา
        final_prompt_parts = []
        if image_bytes:
            # ถ้ามีการส่งรูปภาพมาด้วย...
            try:
                # ใช้ Pillow (PIL) เพื่อเปิดข้อมูล byte ของรูปภาพ
                img = Image.open(io.BytesIO(image_bytes))
                # เพิ่ม Object รูปภาพเข้าไปใน list โดยตรง (นี่คือรูปแบบที่ถูกต้อง)
                final_prompt_parts.append(img)
            except Exception as img_err:
                print(f"Error processing image: {img_err}")
                raise ValueError("Invalid image data provided.")

        # 3. เพิ่มข้อความ (prompt) ล่าสุดต่อท้ายรูปภาพ (ถ้ามี)
        final_prompt_parts.append(prompt)

        # 4. นำ 'final_prompt_parts' ทั้งหมด (อาจจะมีแค่ข้อความ หรือมีรูป+ข้อความ)
        #    เพิ่มเข้าไปเป็นเทิร์นล่าสุดของ 'contents'
        contents.append(final_prompt_parts)

        # --- สิ้นสุดการแก้ไข ---

        # เรียก API แบบ Stream ด้วย `contents` ที่สร้างขึ้นอย่างสมบูรณ์
        async for chunk in await client.aio.models.generate_content_stream(
            model=model_name,
            contents=contents,
        ):
            if hasattr(chunk, "text") and chunk.text:
                # ส่งข้อมูลกลับไปในรูปแบบ Server-Sent Events (SSE)
                data = json.dumps({"text": chunk.text})
                yield f"data: {data}\n\n"

    except Exception as e:
        print(f"An error occurred during streaming: {e}")
        error_message = json.dumps({"error": f"An error occurred: {str(e)}"})
        yield f"data: {error_message}\n\n"


@app.post("/api/generate-stream")
async def generate_stream(
    # รับข้อมูลจาก Form Data ที่ส่งมาจาก Frontend
    history: str = Form(...),
    prompt: str = Form(...),
    model: str = Form(...),
    image: Optional[UploadFile] = File(None) # ไฟล์รูปภาพ (อาจไม่มีก็ได้)
):
    """
    Endpoint หลักสำหรับรับ Request, ประมวลผล, และส่งต่อให้ stream_generator
    """
    try:
        # แปลง history ที่เป็น JSON string กลับมาเป็น Python list of dicts
        history_list = json.loads(history)
        
        # อ่านข้อมูล bytes จากไฟล์ที่อัปโหลด (ถ้ามี)
        image_bytes = await image.read() if image else None

        # คืนค่าเป็น StreamingResponse ที่เรียกใช้ stream_generator
        return StreamingResponse(
            stream_generator(history_list, prompt, model, image_bytes),
            media_type="text/event-stream"
        )
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="Invalid history format. Must be a valid JSON string.")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"An unexpected error occurred: {str(e)}")

# --- Endpoint ใหม่สำหรับ RAG (ไม่ใช้ Streaming) ---
@app.post("/generate-agentic-response")
async def generate_agentic_response(request: AgenticRequest):
    try:
        # 1. สร้าง 'contents' จาก history และ prompt
        contents = []
        for message in request.history:
            role = "user" if message["sender"] == "user" else "model"
            contents.append({'role': role, 'parts': [{'text': message["text"]}]})
        contents.append({'role': 'user', 'parts': [{'text': request.prompt}]})

        # --- การเปลี่ยนแปลงที่สำคัญตามที่คุณค้นพบ ---
        # 2. สร้าง model instance และส่ง tools เข้าไปโดยตรง
        #    นี่คือวิธีที่ทำให้เกิด "Agentic Loop"
        model = genai.GenerativeModel(
            model_name=request.model,
            tools=[tavily_search],# <-- ส่งฟังก์ชันเข้าไปในลิสต์ tools โดยตรง
            system_instruction="You are a helpful and powerful research assistant named Alex-Agent. Your goal is to provide the most accurate and up-to-date information. For any questions regarding recent events, current affairs, statistics, or any topic where information could have changed, you MUST use the `tavily_search` tool. Do not rely on your internal knowledge for these types of questions. Before providing the answer, briefly mention that you are searching for the latest information."
        )

        # 3. เรียก generate_content จาก model instance
        #    SDK จะจัดการเรื่องการเรียกใช้ tool และส่งผลลัพธ์กลับมาให้ AI โดยอัตโนมัติ
        response = model.generate_content(contents)
        # --------------------------------------------

        return {"response": response.text}
    except Exception as e:
        print(f"An error occurred in agentic response: {e}")
        raise HTTPException(status_code=500, detail=str(e))
    
@app.post("/api/ask-document-stream")
async def ask_document_stream(
    question: str = Form(...),
    model: str = Form(...),
    file: UploadFile = File(...)
):
      # --- เพิ่มส่วนการดีบักตรงนี้ ---
    print("--- RAG Endpoint Called ---")
    print(f"Received Question: {question}")
    print(f"Selected Model: {model}")
    if file:
        print(f"File Received: {file.filename}")
        print(f"File Content-Type: {file.content_type}")
    else:
        print("File was NOT received.")
    print("--------------------------")
    try:
        # 1. โหลดและประมวลผลไฟล์ PDF ที่อัปโหลดมา
        with tempfile.NamedTemporaryFile(delete=False, suffix=".pdf") as tmp_file:
            content = await file.read()
            tmp_file.write(content)
            tmp_file_path = tmp_file.name
        

        loader = PyPDFLoader(file_path=tmp_file_path)
        documents = loader.load()  # load() จะโหลดเอกสารทั้งหมดในไฟล์ PDF

        # 2. ตัดแบ่งเอกสารเป็นชิ้นเล็กๆ (Chunking)
        text_splitter = RecursiveCharacterTextSplitter(chunk_size=1000, chunk_overlap=100)
        docs = text_splitter.split_documents(documents)

        

        # 3. สร้าง Embeddings และจัดเก็บลงใน ChromaDB (ในหน่วยความจำ)
        embeddings = GoogleGenerativeAIEmbeddings(model="models/embedding-001", google_api_key=API_KEY)
        vectorstore = Chroma.from_documents(documents=docs, embedding=embeddings)
        retriever = vectorstore.as_retriever(search_kwargs={"k": 3}) # ตั้งค่าให้ดึงข้อมูลที่เกี่ยวข้องที่สุด 3 ชิ้น

        # 4. สร้าง Prompt Template
        template = """
        First, review the following context carefully.
        {context}
        
        Based on the context provided, answer the following question: {question}

        To answer, you must follow these steps:
        1.  **Analyze the Question:** Clearly state what the user is asking for.
        2.  **Extract Relevant Information:** Identify and list the specific pieces of information from the context that are relevant to the question.
        3.  **Synthesize the Answer:** Combine the extracted information to construct a comprehensive answer.

        Provide your final answer based on this step-by-step process.
        """
        prompt = PromptTemplate.from_template(template)

        # 5. สร้าง Chain ที่เชื่อมทุกอย่างเข้าด้วยกัน
        llm = ChatGoogleGenerativeAI(model=model, google_api_key=API_KEY, temperature=0.5, convert_system_message_to_human=True)
        
        chain = (
            {"context": retriever, "question": RunnablePassthrough()}
            | prompt
            | llm
            | StrOutputParser()
        )

        # 6. สร้าง Generator เพื่อ Stream ผลลัพธ์กลับไป
        async def event_stream():
            # ใช้ astream เพื่อให้ได้ผลลัพธ์แบบ streaming
            async for chunk in chain.astream(question):
                data = json.dumps({"text": chunk})
                yield f"data: {data}\n\n"
        
        return StreamingResponse(event_stream(), media_type="text/event-stream")

    except Exception as e:
        print(f"Error in RAG pipeline: {e}")
        # ในกรณีเกิด error เราจะส่ง error message กลับไปใน stream เช่นกัน
        async def error_stream():
            error_message = json.dumps({"error": f"An error occurred: {str(e)}"})
            yield f"data: {error_message}\n\n"
        return StreamingResponse(error_stream(), media_type="text/event-stream") 


if __name__ == "__main__":
    import uvicorn
    # รันเซิร์ฟเวอร์ด้วย Uvicorn
    # --host 0.0.0.0 ทำให้เข้าถึงได้จากภายนอกเครื่อง (เช่น จากมือถือในวง LAN เดียวกัน)
    # --port 8000 คือพอร์ตที่ใช้งาน
    uvicorn.run(app, host="0.0.0.0", port=8000)