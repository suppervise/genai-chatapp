import os
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from dotenv import load_dotenv
from google import genai

from fastapi.middleware.cors import CORSMiddleware

# โหลดตัวแปร environment จากไฟล์ .env
load_dotenv()

# ดึง API key จาก environment variable
API_KEY = os.getenv("GEMINI_API_KEY")
if not API_KEY:
    raise RuntimeError("GEMINI_API_KEY environment variable not set")

# --- การแก้ไขที่ถูกต้องตามที่คุณแนะนำ ---
# สร้าง client สำหรับ Google GenAI SDK โดยตรง
client = genai.Client(api_key=API_KEY)
# -------------------------------------

# สร้าง FastAPI app
app = FastAPI(title="GenAI Chat App API")

origins = [
    "http://localhost:5173",
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,  # อนุญาตเฉพาะ origins ที่อยู่ในลิสต์
    allow_credentials=True, # อนุญาตให้ใช้ cookies (เผื่ออนาคต)
    allow_methods=["*"],    # อนุญาตให้ใช้ HTTP methods ทั้งหมด (GET, POST, etc.)
    allow_headers=["*"],    # อนุญาตให้มี HTTP headers ทั้งหมด
)
# -----------------------------

# สร้าง schema สำหรับรับข้อมูล JSON
class PromptRequest(BaseModel):
    prompt: str
    

# ฟังก์ชันเรียกใช้งาน Google GenAI
def generate_text(prompt: str) -> str:
    try:
        # --- การแก้ไขที่ถูกต้องตามที่คุณแนะนำ ---
        response = client.models.generate_content(
            model="gemini-1.5-flash-latest", # ขออนุญาตใช้ latest เพื่อให้ได้เวอร์ชันใหม่เสมอ
            contents=[prompt]  # ส่งเป็น list ตามโครงสร้างที่ถูกต้อง
        )
        # -------------------------------------
        return response.text
    except Exception as e:
        print(f"An error occurred with the GenAI API: {e}")
        raise RuntimeError(f"GenAI API error: {e}")

# สร้าง API endpoint รับ POST /generate-response
@app.post("/generate-response")
async def generate_response(request: PromptRequest):
    try:
        result = generate_text(request.prompt)
        return {"response": result}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# (ส่วน uvicorn runner เหมือนเดิม)
if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)