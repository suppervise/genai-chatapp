import { useState,type FormEvent, useEffect, useRef } from 'react';
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


// Interface ใหม่สำหรับ Persona ที่รับมาจาก API
interface PersonaTemplate {
  id: string;
  title: string;
  history: Message[];
}


// รายการโมเดลที่มีให้เลือก
const availableModels = [
  { id: 'gemini-1.5-flash-latest', name: 'Gemini 1.5 Flash (เร็ว)' },
  { id: 'gemini-2.5-flash', name: 'Gemini 2.5 flash (เฉียบ)' },
   { id: 'gemini-2.0-flash', name: 'Gemini 2.0 flash (ฉลาดเร็ว)' },
  { id: 'gemini-2.5-pro', name: 'Gemini 2.5 pro (ฉลาดสุขุม)' },

];


function App() {
  const [prompt, setPrompt] = useState<string>('');
  const [chatHistory, setChatHistory] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [selectedModel, setSelectedModel] = useState<string>(availableModels[0].id);
  const chatWindowRef = useRef<HTMLDivElement>(null);
  const [personaLibrary, setPersonaLibrary] = useState<PersonaTemplate[]>([]); // State เก็บ Persona

  const [imageFile, setImageFile] = useState<File | null>(null); // State สำหรับเก็บไฟล์รูป
  const [imagePreview, setImagePreview] = useState<string | null>(null); // State สำหรับเก็บ URL ภาพตัวอย่าง
  const fileInputRef = useRef<HTMLInputElement>(null); // Ref สำหรับ input file ที่ซ่อนอยู่




   // --- useEffect Hooks ---
  // ดึงข้อมูล Persona Library เมื่อแอปโหลด
  useEffect(() => {
    const fetchPersonas = async () => {
      try {
        const response = await axios.get<PersonaTemplate[]>('/api/get-prompts');
        setPersonaLibrary(response.data);
      } catch (error) {
        console.error("Could not fetch persona library:", error);
      }
    };
    fetchPersonas();
  }, []);


  useEffect(() => {
    if (chatWindowRef.current) {
      chatWindowRef.current.scrollTop = chatWindowRef.current.scrollHeight;
    }
  }, [chatHistory]);

  const handleNewChat = () => {
    setChatHistory([]);
  };
   const handleImageChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const file = e.target.files[0];
      setImageFile(file);
      setImagePreview(URL.createObjectURL(file)); // สร้าง URL ชั่วคราวสำหรับแสดงภาพ
    }
  };

    // หัวใจของการเปลี่ยนแปลง: Handler สำหรับเลือก Persona
  const handleSelectPersona = (personaId: string) => {
    if (!personaId) return;

    const selectedPersona = personaLibrary.find(p => p.id === personaId);
    if (selectedPersona) {
      setChatHistory(selectedPersona.history); // ตั้งค่า History ใหม่ทั้งหมด
      setPrompt(''); // เคลียร์ช่อง input
     // removeImage(); // เคลียร์รูปภาพ
    }
  };

  const removeImage = () => {
    setImageFile(null);
    setImagePreview(null);
    if(fileInputRef.current) fileInputRef.current.value = ""; // เคลียร์ค่าใน input
  };

 const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if ((!prompt.trim() && !imageFile) || isLoading) return;

    setIsLoading(true);

    // --- ขั้นตอนที่ 1: เตรียมข้อมูลที่จะส่ง ---
    const formData = new FormData();
    // ส่ง chatHistory *ปัจจุบัน* ไปก่อน
    formData.append('history', JSON.stringify(chatHistory));
    formData.append('prompt', prompt);
    formData.append('model', selectedModel);
    if (imageFile) {
      formData.append('image', imageFile);
    }

    // --- ขั้นตอนที่ 2: อัปเดต UI ทันที ---
    // สร้างข้อความของผู้ใช้ที่จะแสดงบนหน้าจอ
    const userMessageText = imageFile ? `[Image Attached] ${prompt}` : prompt;
    const userMessage: Message = { sender: 'user', text: userMessageText };
    
    // เพิ่มข้อความ user และ placeholder ของ AI เข้าไปใน state *ในครั้งเดียว*
    setChatHistory(prev => [...prev, userMessage, { sender: 'ai', text: '' }]);
    
    // เคลียร์ input และรูปภาพ
    setPrompt('');
    removeImage();


  try {
    const response = await fetch('/api/generate-stream', {
      method: 'POST',
      body: formData, // ส่ง FormData แทน JSON.stringify
      

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



  return (
    <div className="app-container">
      {/* --- ส่วน Header ที่เพิ่มเข้ามาใหม่ --- */}
      <div className="app-header">
        <button onClick={handleNewChat} className="new-chat-btn">
          <NewChatIcon /> New Chat
        </button>
        
           {/* --- Dropdown สำหรับ Persona --- */}
        <div className="persona-selector">
          <label htmlFor="persona-select">Persona:</label>
          <select 
            id="persona-select"
            onChange={e => handleSelectPersona(e.target.value)}
            value="" // ใช้ value ว่างๆ เพื่อให้เลือกซ้ำได้
          >
            <option value="" disabled>-- Change Persona --</option>
            {personaLibrary.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title}
              </option>
            ))}
          </select>
        </div>
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
  {/* --- นี่คือโครงสร้างที่ถูกต้องสำหรับส่วน Input --- */}
      <div className="input-area">
        {imagePreview && (
          <div className="image-preview-container">
            <img src={imagePreview} alt="Preview" className="image-preview" />
            <button onClick={removeImage} className="remove-image-btn">&times;</button>
          </div>
        )}
        <form className="chat-input-form" onSubmit={handleSubmit}>
            <input 
              type="file" 
              ref={fileInputRef} 
              onChange={handleImageChange} 
              accept="image/*" 
              style={{ display: 'none' }} 
            />
            <button 
              type="button" 
              onClick={() => fileInputRef.current?.click()} 
              className="attach-btn"
              title="Attach Image"
            >
              📎
            </button>
            <input
              type="text"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={imageFile ? "Describe the image or ask a question..." : "Ask me anything..."}
              disabled={isLoading}
            />
            <button 
              type="submit" 
              disabled={isLoading || (!prompt.trim() && !imageFile)}
            >
              Send
            </button>
        </form>
      </div>
    </div>
  );
}

export default App;