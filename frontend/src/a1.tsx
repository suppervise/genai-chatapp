import { useState, FormEvent, useEffect, useRef} from 'react';
import axios from 'axios';
import './App.css'; // นำเข้าไฟล์ CSS สำหรับตกแต่ง
import ReactMarkdown from 'react-markdown';


// กำหนด Type สำหรับหน้าตาของแต่ละข้อความ
interface Message {
  sender: 'user' | 'ai';
  text: string;
}

function App() {
  // State 1: เก็บข้อความที่ผู้ใช้กำลังพิมพ์อยู่
  const [prompt, setPrompt] = useState<string>('');
  // State 2: เก็บประวัติการแชททั้งหมด เป็น Array ของ Message
  const [chatHistory, setChatHistory] = useState<Message[]>([]);
  // State 3: สถานะการโหลด (เมื่อกำลังรอคำตอบจาก AI)
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const chatWindowRef = useRef<HTMLDivElement>(null); // สร้าง ref สำหรับอ้างอิงถึงหน้าต่างแชท

   // ฟังก์ชันสำหรับเลื่อนลงล่างสุดอัตโนมัติ
  useEffect(() => {
    if (chatWindowRef.current) {
      chatWindowRef.current.scrollTop = chatWindowRef.current.scrollHeight;
    }
  }, [chatHistory, isLoading]); // ทำงานทุกครั้งที่ chatHistory หรือ isLoading เปลี่ยน

  // ฟังก์ชันที่จะทำงานเมื่อผู้ใช้กดส่งฟอร์ม
  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault(); // ป้องกันไม่ให้หน้าเว็บรีโหลด
    if (!prompt.trim() || isLoading) return; // ถ้าไม่ได้พิมพ์อะไรมา หรือกำลังโหลดอยู่ ก็ไม่ต้องทำอะไร

    // 1. สร้างข้อความของผู้ใช้และเพิ่มเข้าไปในประวัติการแชท
    const userMessage: Message = { sender: 'user', text: prompt };
    setChatHistory(prev => [...prev, userMessage]);
    const currentPrompt = prompt; // เก็บ prompt ปัจจุบันไว้ใช้
    setPrompt(''); // เคลียร์ช่องพิมพ์
    setIsLoading(true); // เริ่มสถานะโหลด

    try {
      // 2. ส่ง Request ไปยัง Backend API ของเรา
      const response = await axios.post('http://127.0.0.1:8000/generate-response', {
        prompt: prompt, // ส่ง prompt ที่ผู้ใช้พิมพ์ไปใน body
      });

      // 3. สร้างข้อความของ AI และเพิ่มเข้าไปในประวัติการแชท
      const aiMessage: Message = { sender: 'ai', text: response.data.response };
      setChatHistory(prev => [...prev, aiMessage]);

    } catch (error) {
      // 4. หากมีข้อผิดพลาด
      console.error("Error fetching AI response:", error);
      const errorMessage: Message = { sender: 'ai', text: "Sorry, something went wrong. Please try again." };
      setChatHistory(prev => [...prev, errorMessage]);
    } finally {
      setIsLoading(false); // หยุดสถานะโหลด ไม่ว่าจะสำเร็จหรือล้มเหลว
    }
  };

  return (
 <div className="app-container">
      {/* เพิ่ม ref ที่นี่ */}
      <div className="chat-window" ref={chatWindowRef}>
        {chatHistory.map((msg, index) => (
          <div key={index} className={`message ${msg.sender}`}>
            {/* 2. ใช้ ReactMarkdown แทน <p> สำหรับข้อความจาก AI */}
            {msg.sender === 'ai' ? (
              <ReactMarkdown>{msg.text}</ReactMarkdown>
            ) : (
              <p>{msg.text}</p> // ข้อความ user ยังใช้ <p> เหมือนเดิม
            )}
          </div>
        ))}
    {isLoading && <div className="message ai"><p>AI is thinking...</p></div>}
      </div><br></br>
      <form className="chat-input-form" onSubmit={handleSubmit}>
        <input
          type="text"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Ask me anything..."
          disabled={isLoading}
        />
        <button type="submit" disabled={isLoading}>Send</button>
      </form>
    </div>
  );
}

export default App;