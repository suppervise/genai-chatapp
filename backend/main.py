# main.py (Final Corrected Version)
import aiofiles
import os
import json
import io
import tempfile
from typing import AsyncGenerator, List, Dict, Optional, Generator

# --- FastAPI & Related Imports ---
from fastapi import FastAPI, HTTPException, File, UploadFile, Form
# ... (all other imports are the same) ...
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from google import genai
from langchain_google_genai import GoogleGenerativeAIEmbeddings, ChatGoogleGenerativeAI
from dotenv import load_dotenv
from langchain.text_splitter import RecursiveCharacterTextSplitter
from langchain.prompts import PromptTemplate
from langchain.schema.runnable import RunnablePassthrough
from langchain.schema.output_parser import StrOutputParser
from langchain_community.document_loaders import PyPDFLoader
from langchain_community.vectorstores import Chroma
from langchain.agents import AgentExecutor, create_react_agent
from langchain_community.tools import TavilySearchResults
from langchain import hub
from PIL import Image
from tavily import TavilyClient

# ==============================================================================
# 1. SETUP & CONFIGURATION (Unchanged)
# ==============================================================================
load_dotenv()
# ... (config code remains the same) ...
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
TAVILY_API_KEY = os.getenv("TAVILY_API_KEY")

if not GEMINI_API_KEY:
    raise RuntimeError("GEMINI_API_KEY environment variable not set.")
if not TAVILY_API_KEY:
    raise RuntimeError("TAVILY_API_KEY environment variable not set.")


client = genai.Client(api_key=GEMINI_API_KEY)
tavily_client = TavilyClient(api_key=TAVILY_API_KEY)

app = FastAPI(
    title="GenAI Chat App API",
    version="2.0.2", # Final fix version
    description="A refactored and professional API for GenAI applications."
)

allowed_origins_regex = r"https?:\/\/localhost:5173|https?:\/\/genai-chatapp(-[a-zA-Z0-9]+)?-boondees-projects\.vercel\.app"
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=allowed_origins_regex,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
# ==============================================================================
# 2. Pydantic Models (Unchanged)
# ==============================================================================
class HistoryItem(BaseModel):
    sender: str
    text: str

class AgenticRequest(BaseModel):
    history: List[HistoryItem]
    prompt: str
    model: str
# ==============================================================================
# 3. HELPER FUNCTIONS (Unchanged)
# ==============================================================================
def format_history_to_gemini_contents(history: List[Dict[str, str]]) -> List[Dict]:
    # ... (function is correct and unchanged) ...
    contents = []
    for message in history:
        if "[Image Attached]" in message["text"]:
            continue
        role = "user" if message["sender"] == "user" else "model"
        contents.append({'role': role, 'parts': [{'text': message["text"]}]})
    return contents


# This function remains a regular 'def' generator
def stream_error_handler(e: Exception) -> Generator[str, None, None]:
    print(f"An error occurred during streaming: {e}")
    error_message = json.dumps({"error": f"An unexpected error occurred on the server."})
    yield f"data: {error_message}\n\n"

# ==============================================================================
# 4. CORE API SERVICES (WITH THE CORRECTED ERROR HANDLING)
# ==============================================================================

# --- Service for General Chat ---
async def general_chat_stream_service(
    history: List[Dict[str, str]],
    prompt: str,
    model_name: str,
    image_bytes: Optional[bytes] = None
) -> AsyncGenerator[str, None]:
    try:
        contents = format_history_to_gemini_contents(history)
        final_prompt_parts = []
        if image_bytes:
            img = Image.open(io.BytesIO(image_bytes))
            final_prompt_parts.append(img)
        final_prompt_parts.append({'text': prompt})
        contents.append({'role': 'user', 'parts': final_prompt_parts})

        # --- THE FIX IS HERE (2/2): Revert to using client.aio.models.generate_content_stream ---
        # REASON: This is the direct, low-level call the user correctly implemented. It's perfectly valid.
        # Added f-string to ensure model name is correctly formatted (e.g., 'models/gemini-1.5-flash-latest')
        response_stream = await client.aio.models.generate_content_stream(
            model=f"models/{model_name}",
            contents=contents
        )

        async for chunk in response_stream:
            if hasattr(chunk, "text") and chunk.text:
                yield f'data: {json.dumps({"text": chunk.text})}\n\n'
    except Exception as e:
        for error_chunk in stream_error_handler(e):
            yield error_chunk


# --- Service for RAG ---
async def rag_stream_service(question: str, model_name: str, file_content: bytes) -> AsyncGenerator[str, None]:

    
    try:
        # ... (main logic) ...
        async with aiofiles.tempfile.NamedTemporaryFile(delete=False, suffix=".pdf") as tmp_file:
           await tmp_file.write(file_content)
           tmp_file_path = tmp_file.name
        # ... (rest of the RAG logic)
        loader = PyPDFLoader(file_path=tmp_file_path)
        documents = loader.load()
        os.unlink(tmp_file_path) # Clean up the temp file

        text_splitter = RecursiveCharacterTextSplitter(chunk_size=1000, chunk_overlap=100)
        docs = text_splitter.split_documents(documents)

        embeddings = GoogleGenerativeAIEmbeddings(model="models/embedding-001", google_api_key=GEMINI_API_KEY)
        vectorstore = Chroma.from_documents(documents=docs, embedding=embeddings)
        retriever = vectorstore.as_retriever(search_kwargs={"k": 3})
        # ...
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
        prompt_template = PromptTemplate.from_template(template)
        llm = ChatGoogleGenerativeAI(model=model_name, google_api_key=GEMINI_API_KEY, temperature=0.3, convert_system_message_to_human=True)
        chain = (
            {"context": retriever, "question": RunnablePassthrough()}
            | prompt_template
            | llm
            | StrOutputParser()
        )
        async for chunk in chain.astream(question):
            yield f'data: {json.dumps({"text": chunk})}\n\n'
    except Exception as e:
        # THE CORRECT FIX: Use a 'for' loop to yield from the sync generator
        for error_chunk in stream_error_handler(e):
            yield error_chunk

    finally:
         # ลบไฟล์ชั่วคราวเมื่อใช้งานเสร็จ
        if 'tmp_file_path' in locals() and os.path.exists(tmp_file_path):
            os.unlink(tmp_file_path)

# --- Service for Agent ---
async def agent_stream_service(question: str, model_name: str) -> AsyncGenerator[str, None]:
    try:
        # ... (main logic) ...
        llm = ChatGoogleGenerativeAI(model=model_name, google_api_key=GEMINI_API_KEY, temperature=0, stream=True)
        tools = [TavilySearchResults(max_results=3, api_key=TAVILY_API_KEY)]
        prompt = hub.pull("hwchase17/react")
        agent = create_react_agent(llm, tools, prompt)
        agent_executor = AgentExecutor(agent=agent, tools=tools, verbose=True, handle_parsing_errors=True)
        async for event in agent_executor.astream_events({"input": question}, version="v1"):
            # ... (event handling logic) ...
            kind = event["event"]
            if kind == "on_chain_start" and event["name"] == "Agent":
                thought = f"Agent started with input: {event['data']['input']}\n"
                yield f'data: {json.dumps({"text": thought, "type": "thought"})}\n\n'
            elif kind == "on_tool_end":
                tool_output = f"Tool `{event['name']}` finished.\nOutput:\n```\n{event['data']['output']}\n```\n"
                yield f'data: {json.dumps({"text": tool_output, "type": "thought"})}\n\n'
            elif kind == "on_chat_model_stream":
                chunk_content = event["data"]["chunk"].content
                if chunk_content:
                    yield f'data: {json.dumps({"text": chunk_content, "type": "final_answer_chunk"})}\n\n'
    except Exception as e:
        # THE CORRECT FIX: Use a 'for' loop to yield from the sync generator
        for error_chunk in stream_error_handler(e):
            yield error_chunk

# ==============================================================================
# 5. API ENDPOINTS (No changes needed here)
# ==============================================================================
# ... (All endpoints @app.post, @app.get remain the same) ...
@app.get("/")
def read_root():
    return {"status": "GenAI Chat App Backend is running!"}

@app.get("/api/get-prompts")
async def get_prompts():
    try:
        with open("prompts.json", "r", encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Prompts file not found.")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/generate-stream")
async def generate_stream(
    history: str = Form(...),
    prompt: str = Form(...),
    model: str = Form(...),
    image: Optional[UploadFile] = File(None)
):
    try:
        history_list = json.loads(history)
        image_bytes = await image.read() if image else None
        return StreamingResponse(
            general_chat_stream_service(history_list, prompt, model, image_bytes),
            media_type="text/event-stream"
        )
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="Invalid history format.")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/ask-document-stream")
async def ask_document_stream(
    question: str = Form(...),
    model: str = Form(...),
    file: UploadFile = File(...)
):
    if not file.content_type == "application/pdf":
        raise HTTPException(status_code=400, detail="Invalid file type. Only PDF is supported.")
    try:
        file_content = await file.read()
        return StreamingResponse(
            rag_stream_service(question, model, file_content),
            media_type="text/event-stream"
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/run-agent-stream")
async def run_agent_stream(
    question: str = Form(...),
    model: str = Form(...)
):
    try:
        return StreamingResponse(
            agent_stream_service(question, model),
            media_type="text/event-stream"
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
# ==============================================================================
# 6. SERVER RUN
# ==============================================================================
if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)