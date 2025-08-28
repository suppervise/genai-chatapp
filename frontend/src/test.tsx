import { useState, type FormEvent, useEffect, useRef, type ChangeEvent } from 'react';
import ReactMarkdown from 'react-markdown';
import './App.css';
import axios from 'axios';


// --- Interfaces (อัปเดต Message interface) ---
interface Message {
  sender: 'user' | 'ai';
  text: string;
  type?: 'thought' | 'final_answer' | 'user_input'; // เพิ่ม type สำหรับ Agent
}

interface PersonaTemplate {
  id: string;
  title: string;
  history: Message[];
}

// --- Constants (อัปเดต Models list ของคุณ) ---
const availableModels = [
  { id: 'gemini-1.5-flash-latest', name: 'Gemini 1.5 Flash' },
  { id: 'gemini-1.5-pro-latest', name: 'Gemini 1.5 Pro' },
];

const isProduction = process.env.NODE_ENV === 'production';
const BACKEND_URL = isProduction 
  ? 'https://genai-chatapp-backend.onrender.com' // <-- URL สำหรับ Production
  : 'http://127.0.0.1:8000';                   // <-- URL สำหรับ Localhost

// --- Main App Component ---
function App() {
  // --- States ---
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [selectedModel, setSelectedModel] = useState<string>(availableModels[0].id);
  const [personaLibrary, setPersonaLibrary] = useState<PersonaTemplate[]>([]);
  const [chatMode, setChatMode] = useState<'general' | 'rag' | 'agent'>('general');

  // State for each mode
  const [generalChatHistory, setGeneralChatHistory] = useState<Message[]>([]);
  const [generalPrompt, setGeneralPrompt] = useState<string>('');
  const [generalImageFile, setGeneralImageFile] = useState<File | null>(null);
  const [generalImagePreview, setGeneralImagePreview] = useState<string | null>(null);

  const [ragChatHistory, setRagChatHistory] = useState<Message[]>([]);
  const [ragPrompt, setRagPrompt] = useState<string>('');
  const [ragFile, setRagFile] = useState<File | null>(null);
  const [ragFileName, setRagFileName] = useState<string>('');
  
  // *** State ใหม่สำหรับ Agent ***
  const [agentChatHistory, setAgentChatHistory] = useState<Message[]>([]);
  const [agentPrompt, setAgentPrompt] = useState<string>('');

  // --- Refs ---
  const chatWindowRef = useRef<HTMLDivElement>(null);
  const generalFileInputRef = useRef<HTMLInputElement>(null);
  const ragFileInputRef = useRef<HTMLInputElement>(null);


   // Fetch personas from the backend when the component mounts
 useEffect(() => {
   const fetchPersonas = async () => {
     try {
       const response = await axios.get<PersonaTemplate[]>(`${BACKEND_URL}/api/get-prompts`);
       setPersonaLibrary(response.data);
     } catch (error) {
       console.error("Could not fetch persona library:", error);
     }
   };
   fetchPersonas();
 }, []);
  // --- useEffects (เหมือนเดิม) ---
  useEffect(() => { /* ... Fetch personas ... */ }, []);
  useEffect(() => { /* ... Auto-scroll ... */ }, [generalChatHistory, ragChatHistory, agentChatHistory, isLoading]);

  // --- Handlers ---
  const handleModeChange = (mode: 'general' | 'rag' | 'agent') => setChatMode(mode);

  const removeGeneralImage = () => {
  setGeneralImageFile(null);
  setGeneralImagePreview(null);
  if (generalFileInputRef.current) generalFileInputRef.current.value = "";
};
  
  // ... (Handlers อื่นๆ ส่วนใหญ่เหมือนเดิม) ...

    // Handles selecting a new persona, which resets the chat to that persona's context
  const handleSelectPersona = (personaId: string) => {
    if (!personaId) return;
    const selected = personaLibrary.find(p => p.id === personaId);
    if (selected) {
      setGeneralChatHistory(selected.history);
      setChatMode('general'); // Switch to general mode when a persona is selected
    }
  };

    // Handles file selection for the RAG mode
  const handleRagFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const file = e.target.files[0];
      setRagFile(file);
      setRagFileName(file.name);
      setRagChatHistory([]); // Start a new chat session for the new document
    }
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (isLoading) return;

    if (chatMode === 'general') await handleGeneralSubmit();
    else if (chatMode === 'rag') await handleRagSubmit();
    else if (chatMode === 'agent') await handleAgentSubmit();
  };

  // Handles image selection for the General mode
const handleGeneralImageChange = (e: ChangeEvent<HTMLInputElement>) => {
   if (e.target.files && e.target.files[0]) {
    const file = e.target.files[0];
    setGeneralImageFile(file);
    setGeneralImagePreview(URL.createObjectURL(file));
  }
};

  // *** Handler ใหม่สำหรับ Agent Submit ***
  const handleAgentSubmit = async () => {
    if (!agentPrompt.trim()) return;
    setIsLoading(true);

    const formData = new FormData();
    formData.append('question', agentPrompt);
    formData.append('model', selectedModel);

    // เพิ่ม prompt ของผู้ใช้เข้าไปใน history
    setAgentChatHistory(prev => [...prev, { sender: 'user', text: agentPrompt, type: 'user_input' }]);
    // เพิ่ม placeholder ว่างๆ สำหรับรับข้อมูลจาก AI
    setAgentChatHistory(prev => [...prev, { sender: 'ai', text: '', type: 'thought' }]);
    setAgentPrompt('');

    try {
      const response = await fetch(`${BACKEND_URL}/api/run-agent-stream`, {
        method: 'POST',
        body: formData,
      });

      if (!response.body) return;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let done = false;

      while (!done) {
        const { value, done: readerDone } = await reader.read();
        done = readerDone;
        const chunk = decoder.decode(value, { stream: true });
        
        const lines = chunk.split('\n\n');
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const dataStr = line.substring(6);
            if (dataStr.trim()) {
              const data = JSON.parse(dataStr);
              if (data.text) {
                setAgentChatHistory(prev => {
                  const newHistory = [...prev];
                  const lastMessage = newHistory[newHistory.length - 1];
                  
                  // ถ้า AI ส่ง `thought` มา ให้ต่อท้าย `thought` เดิม
                  if (data.type === 'thought' && lastMessage?.type === 'thought') {
                    lastMessage.text += data.text;
                  } 
                  // ถ้า AI ส่ง `final_answer` มา ให้แทนที่ `thought` สุดท้ายด้วยคำตอบ
                  else if (data.type === 'final_answer' && lastMessage?.type === 'thought') {
                    lastMessage.text = data.text;
                    lastMessage.type = 'final_answer';
                  }
                  return newHistory;
                });
              } // ... (handle error)
            }
          }
        }
      }
    } catch (error) {
      // ... (handle error)
    } finally {
      setIsLoading(false);
    }
  };

  // ... (handleGeneralSubmit และ handleRagSubmit เหมือนเดิม) ...

  // Handles form submission for the General Chat mode
const handleGeneralSubmit = async () => {
  if (!generalPrompt.trim() && !generalImageFile) return;
  setIsLoading(true);
  const formData = new FormData();
  formData.append('history', JSON.stringify(generalChatHistory));
  formData.append('prompt', generalPrompt);
  formData.append('model', selectedModel);
  if (generalImageFile) {
    formData.append('image', generalImageFile);
  }
  const userMessageText = generalImageFile ? `[Image: ${generalImageFile.name}] ${generalPrompt}` : generalPrompt;
  setGeneralChatHistory(prev => [...prev, { sender: 'user', text: userMessageText }, { sender: 'ai', text: '' }]);
  
  // Reset inputs after submission
  setGeneralPrompt('');
  removeGeneralImage();
  try {
      const response = await fetch(`${BACKEND_URL}/api/generate-stream`, {
          method: 'POST',
          body: formData,
      });
      if (!response.body) return;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      
      let done = false;
      while (!done) {
          const { value, done: readerDone } = await reader.read();
          done = readerDone;
          const chunk = decoder.decode(value, { stream: true });
          
          const lines = chunk.split('\n\n');
          for (const line of lines) {
              if (line.startsWith('data: ')) {
                  const dataStr = line.substring(6);
                  if (dataStr.trim()) {
                      const data = JSON.parse(dataStr);
                      if (data.text) {
                          setGeneralChatHistory(prev => {
                              const newHistory = [...prev];
                              const lastMessage = newHistory[newHistory.length - 1];
                              if (lastMessage?.sender === 'ai')
                                 if (!lastMessage.text.endsWith(data.text)) 
                                    {
                                     lastMessage.text += data.text;
                                   }
                              return newHistory;
                          });
                      } else if (data.error) {
                          // Handle error from stream
                           setGeneralChatHistory(prev => {
                              const newHistory = [...prev];
                              const lastMessage = newHistory[newHistory.length - 1];
                              if (lastMessage?.sender === 'ai') {
                                  lastMessage.text = `Error: ${data.error}`;
                              }
                              return newHistory;
                          });
                      }
                  }
              }
          }
      }
  } catch (error) {
      console.error("Error fetching general chat response:", error);
       setGeneralChatHistory(prev => {
          const newHistory = [...prev];
          const lastMessage = newHistory[newHistory.length - 1];
          if (lastMessage?.sender === 'ai') {
              lastMessage.text = "Sorry, a connection error occurred.";
          }
          return newHistory;
      });
  } finally {
      setIsLoading(false);
  }
};

  // Handles form submission for the RAG Chat mode

const handleRagSubmit = async () => {
  if (!ragPrompt.trim() || !ragFile) {
    alert("Please upload a PDF file and ask a question.");
    return;
  }
  setIsLoading(true);

  const formData = new FormData();
  formData.append('question', ragPrompt);
  formData.append('model', selectedModel);
  formData.append('file', ragFile);

  // เพิ่มข้อความผู้ใช้และเตรียมข้อความว่างสำหรับ AI
  setRagChatHistory(prev => [...prev, { sender: 'user', text: ragPrompt }, { sender: 'ai', text: '' }]);
  setRagPrompt('');

  try {
    const response = await fetch(`${BACKEND_URL}/api/ask-document-stream`, {
      method: 'POST',
      body: formData,
    });

    if (!response.body) {
      throw new Error("ReadableStream not supported in this browser.");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let done = false;
    let buffer = '';

    while (!done) {
      const { value, done: readerDone } = await reader.read();
      done = readerDone;
      buffer += decoder.decode(value || new Uint8Array(), { stream: true });

      // แบ่ง buffer ตามตัวแบ่งของ SSE (\n\n)
      const parts = buffer.split('\n\n');

      // ประมวลผลทุกส่วนที่สมบูรณ์ (ยกเว้นส่วนสุดท้าย)
      for (let i = 0; i < parts.length - 1; i++) {
        const line = parts[i];

        if (line.startsWith('data: ')) {
          const dataStr = line.substring(6).trim();

          if (dataStr) {
            try {
              const data = JSON.parse(dataStr);

              if (data.text) {
                setRagChatHistory(prev => {
                  const newHistory = [...prev];
                  const lastMessage = newHistory[newHistory.length - 1];
                  if (lastMessage?.sender === 'ai') {
                    // ป้องกันข้อความซ้ำ
                    if (!lastMessage.text.endsWith(data.text)) {
                      lastMessage.text += data.text;
                    }
                  }
                  return newHistory;
                });
              } else if (data.error) {
                setRagChatHistory(prev => {
                  const newHistory = [...prev];
                  const lastMessage = newHistory[newHistory.length - 1];
                  if (lastMessage?.sender === 'ai') {
                    lastMessage.text = `Error: ${data.error}`;
                  }
                  return newHistory;
                });
              }
            } catch (error) {
              console.error("Error parsing JSON stream chunk:", error, dataStr);
            }
          }
        }
      }

      // เก็บข้อความที่ยังไม่สมบูรณ์ไว้เพื่อประมวลผลในรอบถัดไป
      buffer = parts[parts.length - 1];
    }
  } catch (error) {
    console.error("Error fetching RAG response:", error);
    setRagChatHistory(prev => {
      const newHistory = [...prev];
      const lastMessage = newHistory[newHistory.length - 1];
      if (lastMessage?.sender === 'ai') {
        lastMessage.text = "Sorry, a connection error occurred.";
      }
      return newHistory;
    });
  } finally {
    setIsLoading(false);
  }
};

  // --- Render Logic (อัปเดตให้รองรับ 3 โหมด) ---
  const currentChatHistory = 
    chatMode === 'general' ? generalChatHistory :
    chatMode === 'rag' ? ragChatHistory :
    agentChatHistory;

  const currentPrompt = 
    chatMode === 'general' ? generalPrompt :
    chatMode === 'rag' ? ragPrompt :
    agentPrompt;

  const setCurrentPrompt = 
    chatMode === 'general' ? setGeneralPrompt :
    chatMode === 'rag' ? setRagPrompt :
    setAgentPrompt;


  return (
    <div className="app-container">
      {/* --- Header Area (เพิ่มปุ่ม Agent) --- */}
      <div className="app-header">
        <div className="mode-toggle">
          <button onClick={() => handleModeChange('general')} className={chatMode === 'general' ? 'active' : ''}>Chat</button>
          <button onClick={() => handleModeChange('rag')} className={chatMode === 'rag' ? 'active' : ''}>Document</button>
          <button onClick={() => handleModeChange('agent')} className={chatMode === 'agent' ? 'active' : ''}>Agent</button>
        </div>
        <div className="header-controls">
           <select 
   onChange={e => handleSelectPersona(e.target.value)} 
   value="" // ตั้งเป็นค่าว่างเสมอเพื่อให้เลือกซ้ำได้
   className="persona-selector"
 >
   <option value="" disabled>-- Change Persona --</option>
   {personaLibrary.map((p) => (
     <option key={p.id} value={p.id}>{p.title}</option>
   ))}
 </select>
 
 <select 
   value={selectedModel} 
   onChange={e => setSelectedModel(e.target.value)} 
   disabled={isLoading}
   className="model-selector"
 >
   {availableModels.map(model => (
     <option key={model.id} value={model.id}>{model.name}</option>
   ))}
 </select>
        </div>
      </div>

      {/* --- Chat Display Area (เพิ่ม class สำหรับ thought) --- */}
      <div className="chat-window" ref={chatWindowRef}>
        {currentChatHistory.map((msg, index) => (
          <div key={index} className={`message ${msg.sender} ${msg.type === 'thought' ? 'thought-message' : ''}`}>
            {msg.type === 'thought' && <span className="thought-label">Thinking...</span>}
            <ReactMarkdown>{msg.text}</ReactMarkdown>
          </div>
        ))}
        {isLoading && <div className="message ai"><div className="typing-indicator"><span></span><span></span><span></span></div></div>}
      </div>

      {/* --- Input Area (อัปเดตให้รองรับ Agent) --- */}
      <div className="input-area">
       {chatMode === 'rag' && (
  <div className="rag-controls">
    <button onClick={() => ragFileInputRef.current?.click()} className="upload-btn">
      {ragFileName ? `✔ ${ragFileName}` : 'Select PDF Document'}
    </button>
    <input type="file" ref={ragFileInputRef} onChange={handleRagFileChange} accept=".pdf" style={{ display: 'none' }} />
  </div>
)}
        
{chatMode === 'general' && generalImagePreview && (
     <div className="image-preview-container">
        <img src={generalImagePreview} alt="Preview" className="image-preview" />
        <button onClick={removeGeneralImage} className="remove-image-btn">&times;</button>
    </div>
)}
       {chatMode === 'rag' && (
  <div className="rag-controls">
    <button onClick={() => ragFileInputRef.current?.click()} className="upload-btn">
      {ragFileName ? `✔ ${ragFileName}` : 'Select PDF Document'}
    </button>
    <input type="file" ref={ragFileInputRef} onChange={handleRagFileChange} accept=".pdf" style={{ display: 'none' }} />
  </div>
)}
        
{chatMode === 'general' && generalImagePreview && (
     <div className="image-preview-container">
        <img src={generalImagePreview} alt="Preview" className="image-preview" />
        <button onClick={removeGeneralImage} className="remove-image-btn">&times;</button>
    </div>
)}

        <form className="chat-input-form" onSubmit={handleSubmit}>
          {chatMode === 'general' && (
            <>
              <button type="button" onClick={() => generalFileInputRef.current?.click()} className="attach-btn" title="Attach Image">📎</button>
              <input type="file" ref={generalFileInputRef} onChange={handleGeneralImageChange} accept="image/*" style={{ display: 'none' }} />
            </>
          )}


          <input
            type="text"
            value={currentPrompt}
            onChange={(e) => setCurrentPrompt(e.target.value)}
            placeholder={
              chatMode === 'agent' ? 'Give me a complex task...' :
              chatMode === 'rag' ? (ragFile ? 'Ask about the document...' : 'Please select a document.') : 
              'Ask anything...'
            }
            disabled={isLoading || (chatMode === 'rag' && !ragFile)}
          />
          <button type="submit" disabled={isLoading || !currentPrompt.trim()}>Send</button>
        </form>
      </div>
    </div>
  );
}

export default App;