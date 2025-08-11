import { useState, FormEvent, useEffect, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import './App.css';
import axios from 'axios'; // เราจะใช้ axios สำหรับ GET request ง่ายๆ

// ไอคอนสำหรับปุ่ม New Chat (สามารถใช้รูปภาพหรือ SVG อื่นๆ ได้)
const NewChatIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M12 5V19M5 12H19" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);


interface Message {
  sender: 'user' | 'ai';
  text: string;
}

// สร้าง Type สำหรับ Prompt Library
interface PromptTemplate {
  title: string;
  prompt: string;
}

// รายการโมเดลที่มีให้เลือก
const availableModels = [
  { id: 'gemini-1.5-flash-latest', name: 'Gemini 1.5 Flash (เร็ว)' },
  { id: 'gemini-1.5-pro-latest', name: 'Gemini 1.5 Pro (ฉลาด)' },
];

function App() {
  const [prompt, setPrompt] = useState<string>('');
  const [chatHistory, setChatHistory] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [selectedModel, setSelectedModel] = useState<string>(availableModels[0].id);
  const chatWindowRef = useRef<HTMLDivElement>(null);

  const [promptLibrary, setPromptLibrary] = useState<PromptTemplate[]>([]); // <-- State ใหม่สำหรับเก็บคลังพร้อมท์

  // --- การเปลี่ยนแปลงสำคัญ: ใช้ useEffect ดึงข้อมูล Prompt ตอนเริ่ม ---
  useEffect(() => {
    const fetchPrompts = async () => {
      try {
        const response = await axios.get('http://127.0.0.1:8000/get-prompts');
        setPromptLibrary(response.data);
      } catch (error) {
        console.error("Could not fetch prompt library:", error);
      }
    };
    fetchPrompts();
  }, []); // dependency array ว่างเปล่า หมายถึงให้ทำงานแค่ครั้งเดียวตอน component โหลด

  useEffect(() => {
    if (chatWindowRef.current) {
      chatWindowRef.current.scrollTop = chatWindowRef.current.scrollHeight;
    }
  }, [chatHistory]);

  const handleNewChat = () => {
    setChatHistory([]);
  };


const handleSubmit = async (e: FormEvent) => {
  e.preventDefault();
  if (!prompt.trim() || isLoading) return;

  const userMessage: Message = { sender: 'user', text: prompt };

  // สร้าง history ที่จะส่งไปให้ backend จาก state ปัจจุบัน
  // เราไม่ส่งข้อความ AI ที่ว่างเปล่าเข้าไปใน history
  const historyForApi = [...chatHistory, userMessage];

    // อัปเดต UI ทันที
  setChatHistory(prev => [...prev, userMessage, { sender: 'ai', text: '' }])

// 
  // const aiMessagePlaceholder: Message = { sender: 'ai', text: '' };
  // setChatHistory(prev => [...prev, aiMessagePlaceholder]);
// 
  const currentPrompt = prompt;
  setPrompt('');
  setIsLoading(true);

  try {
    const response = await fetch('http://127.0.0.1:8000/generate-stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ history: historyForApi, prompt: currentPrompt, model: selectedModel }),

    });

    if (!response.body) return;

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let done = false;
    let buffer = '';

    while (!done) {
      const { value, done: readerDone } = await reader.read();
      done = readerDone;

      buffer += decoder.decode(value, { stream: true });

      const parts = buffer.split('\n\n');

      for (let i = 0; i < parts.length - 1; i++) {
        const line = parts[i];
        if (line.startsWith('data: ')) {
          const dataStr = line.substring(6);
          if (dataStr.trim()) {
            const data = JSON.parse(dataStr);
            if (data.text) {
              setChatHistory(prev =>
                prev.map((msg, idx) =>
                  idx === prev.length - 1 && msg.sender === 'ai'
                    ? { ...msg, text: msg.text + data.text }
                    : msg
                )
              );
            } else if (data.error) {
              console.error('Streaming Error:', data.error);
              setChatHistory(prev =>
                prev.map((msg, idx) =>
                  idx === prev.length - 1 && msg.sender === 'ai'
                    ? { ...msg, text: data.error }
                    : msg
                )
              );
            }
          }
        }
      }

      buffer = parts[parts.length - 1];
    }
  } catch (error) {
    console.error('Error fetching AI stream response:', error);
    setChatHistory(prev =>
      prev.map((msg, idx) =>
        idx === prev.length - 1 && msg.sender === 'ai'
          ? { ...msg, text: 'Sorry, something went wrong with the connection. Please try again.' }
          : msg
      )
    );
  } finally {
    setIsLoading(false);
  }
};

// 3. ฟังก์ชันจัดการเลือก prompt จาก select
const handleSelectPrompt = (selectedPrompt: string) => {
  setPrompt(selectedPrompt); // ตั้ง prompt ใน input
};


  return (
    <div className="app-container">
      {/* --- ส่วน Header ที่เพิ่มเข้ามาใหม่ --- */}
      <div className="app-header">
        <button onClick={handleNewChat} className="new-chat-btn">
          <NewChatIcon /> New Chat
        </button>
        <div className="model-selector">
          <label htmlFor="model-select">Model:</label>
          <select 
            id="model-select" 
            value={selectedModel} 
            onChange={e => setSelectedModel(e.target.value)}
            disabled={isLoading}
          >
            {availableModels.map(model => (
              <option key={model.id} value={model.id}>
                {model.name}
              </option>
            ))}
          </select>
        </div>
      </div>

          {/* --- เพิ่มแถบเครื่องมือใหม่สำหรับ Prompt Library --- */}
      <div className="toolbar">
        <div className="prompt-library-selector">
          <label htmlFor="prompt-select">Prompt Library:</label>
          <select 
            id="prompt-select"
            onChange={e => handleSelectPrompt(e.target.value)}
            value="" // ทำให้เลือกซ้ำได้
          >
            <option value="" disabled>-- เลือกพร้อมท์สำเร็จรูป --</option>
            {promptLibrary.map((p, index) => (
              <option key={index} value={p.prompt}>
                {p.title}
              </option>
            ))}
          </select>
        </div>
      </div>
      
      <div className="chat-window" ref={chatWindowRef}>
        {chatHistory.map((msg, index) => (
          <div key={index} className={`message ${msg.sender}`}>
            <ReactMarkdown>{msg.text}</ReactMarkdown>
          </div>
        ))}
        {isLoading && chatHistory[chatHistory.length - 1]?.text === '' && (
          <div className="message ai">
            <div className="typing-indicator">
              <span></span><span></span><span></span>
            </div>
          </div>
        )}
      </div>
      
      <form className="chat-input-form" onSubmit={handleSubmit}>
        <input
          type="text"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Ask me anything..."
          disabled={isLoading}
        />
        <button type="submit" disabled={isLoading || !prompt.trim()}>Send</button>
      </form>
    </div>
  );
}

export default App;