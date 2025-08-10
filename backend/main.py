import os
import json
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from dotenv import load_dotenv
from google import genai
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from typing import Generator
from typing import AsyncGenerator # *** เปลี่ยนเป็น AsyncGenerator ***

# --- ส่วน Setup เหมือนเดิม ---
load_dotenv()
API_KEY = os.getenv("GEMINI_API_KEY")
if not API_KEY:
    raise RuntimeError("GEMINI_API_KEY environment variable not set")

client = genai.Client(api_key=API_KEY)
app = FastAPI(title="GenAI Chat App API")

origins = ["http://localhost:5173"]
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- แก้ไข PromptRequest ให้รับชื่อ Model ด้วย ---
class StreamPromptRequest(BaseModel):
    prompt: str
    model: str # รับชื่อโมเดลจาก Frontend

# *** เปลี่ยนเป็น async def ***
async def stream_generator(prompt: str, model_name: str) -> AsyncGenerator[str, None]:
    """
    ฟังก์ชันเรียก Gemini API แบบ stream และ yield ข้อความทีละส่วน
    """
    try:
        # --- การแก้ไข: เปลี่ยนไปใช้ generate_content_stream ---
        # เมธอดนี้เป็น async ดังนั้นเราจึงต้องใช้ 'async for'
        async for chunk in await client.aio.models.generate_content_stream(
            
            model=model_name,
            contents=[prompt],
            # ไม่ต้องมี stream=True อีกต่อไป
        ):
            if hasattr(chunk, "text") and chunk.text:
                data = json.dumps({"text": chunk.text})
                yield f"data: {data}\n\n"

    except Exception as e:
        print(f"An error occurred during streaming: {e}")
        error_message = json.dumps({"error": f"Error from AI Model: {e}"})
        yield f"data: {error_message}\n\n"

# --- Endpoint ใหม่สำหรับ Streaming ---
@app.post("/generate-stream")
async def generate_stream(request: StreamPromptRequest):
    """
    Endpoint รับ prompt และ model แล้วส่งผลลัพธ์แบบ stream กลับไป
    """
    return StreamingResponse(
        stream_generator(request.prompt, request.model),
        media_type="text/event-stream" # Media type สำคัญสำหรับ Streaming
    )

# --- Endpoint เดิมยังคงไว้ (เผื่อต้องการใช้) แต่เราจะเน้นใช้ตัวใหม่ ---
class PromptRequest(BaseModel):
    prompt: str

@app.post("/generate-response")
async def generate_response(request: PromptRequest):
    try:
        response = client.models.generate_content(
            model="gemini-1.5-flash-latest",
            contents=[request.prompt]
        )
        return {"response": response.text}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)