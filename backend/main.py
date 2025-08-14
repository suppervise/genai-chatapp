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

from pathlib import Path # นำเข้า Path จาก pathlib

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

# สร้าง client สำหรับ Google GenAI SDK
client = genai.Client(api_key=API_KEY)

# สร้าง FastAPI app
app = FastAPI(title="GenAI Chat App API", version="1.1.0")

# ตั้งค่า CORS Middleware
# origins = ["http://localhost:5173"]
origins = ["http://localhost:5173", "https://chat-agent-inky.vercel.app", "https://chat-agent-7kcu2c9hq-boondees-projects.vercel.app"]
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/")
def read_root():
    return {"status": "GenAI Chat App Backend is running!"}


@app.get("/get-prompts")
async def get_prompts():
    """
    Endpoint สำหรับดึงข้อมูลคลังพร้อมท์จากไฟล์ prompts.json
    """
    try:

         # --- การแก้ไขที่ 2: ใช้ Path ที่สมบูรณ์ในการหาไฟล์ ---
        # สร้าง path ที่ถูกต้องเสมอ ไม่ว่าโค้ดจะถูกรันจากที่ไหน
        PROMPTS_PATH = Path(__file__).parent / "prompts.json"
        with open(PROMPTS_PATH, "r", encoding="utf-8") as f:
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


@app.post("/generate-stream")
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


if __name__ == "__main__":
    import uvicorn
    # รันเซิร์ฟเวอร์ด้วย Uvicorn
    # --host 0.0.0.0 ทำให้เข้าถึงได้จากภายนอกเครื่อง (เช่น จากมือถือในวง LAN เดียวกัน)
    # --port 8000 คือพอร์ตที่ใช้งาน
    uvicorn.run(app, host="0.0.0.0", port=8000)