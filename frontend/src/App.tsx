// App.tsx (Refactored)
import { useState,type  FormEvent, useEffect, useRef,type ChangeEvent, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import axios from 'axios';
import './App.css';

// ==============================================================================
// 1. TYPE DEFINITIONS & CONSTANTS (ส่วนนี้ควรแยกไปไฟล์ types.ts, constants.ts)
// ==============================================================================
type ChatMode = 'general' | 'rag' | 'agent';

interface Message {
  sender: 'user' | 'ai';
  text: string;
  type?: 'thought' | 'final_answer'; // Simplified type for Agent
}

interface PersonaTemplate {
  id: string;
  title: string;
  history: Message[];
}

const AVAILABLE_MODELS = [
  { id: 'gemini-1.5-flash-latest', name: 'Gemini 1.5 Flash' },
  { id: 'gemini-1.5-pro-latest', name: 'Gemini 1.5 Pro' },
  // REASON: Using "latest" is often better for getting updates automatically.
  // Updated model names to be more standard.
];

const isProduction = import.meta.env.PROD; // Vite uses import.meta.env
const BACKEND_URL = isProduction
  ? 'https://genai-chatapp-backend.onrender.com'
  : 'http://127.0.0.1:8000';

// ==============================================================================
// 2. MAIN APP COMPONENT (ควรมีแค่ Logic หลัก, UI ควรแยกเป็น Component ย่อย)
// ==============================================================================
function App() {
  // --- STATE MANAGEMENT ---
  // REASON: รวม State ที่เกี่ยวกับแชทไว้ด้วยกัน ทำให้จัดการง่ายขึ้น
  const [chatState, setChatState] = useState<{ [key in ChatMode]: Message[] }>({
    general: [],
    rag: [],
    agent: [],
  });
  const [prompt, setPrompt] = useState('');
  const [chatMode, setChatMode] = useState<ChatMode>('general');
  const [isLoading, setIsLoading] = useState<boolean>(false);

  // --- App-wide states ---
  const [selectedModel, setSelectedModel] = useState<string>(AVAILABLE_MODELS[0].id);
  const [personaLibrary, setPersonaLibrary] = useState<PersonaTemplate[]>([]);

  // --- File states ---
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [ragFile, setRagFile] = useState<File | null>(null);

  // --- REFS ---
  const chatWindowRef = useRef<HTMLDivElement>(null);
  const fileInputRefs = {
    general: useRef<HTMLInputElement>(null),
    rag: useRef<HTMLInputElement>(null),
  };

  // --- DATA FETCHING & EFFECTS ---
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

  useEffect(() => {
    chatWindowRef.current?.scrollTo({ top: chatWindowRef.current.scrollHeight, behavior: 'smooth' });
  }, [chatState, isLoading]);


  // --- HANDLERS ---
  // REASON: ใช้ useCallback เพื่อป้องกันการสร้างฟังก์ชันใหม่ทุกครั้งที่ re-render
  // ซึ่งจะช่วยเพิ่มประสิทธิภาพ โดยเฉพาะเมื่อส่งฟังก์ชันเหล่านี้ไปยัง Component ลูก
  const handleModeChange = useCallback((mode: ChatMode) => {
    setChatMode(mode);
    setPrompt(''); // Clear prompt when changing mode
  }, []);

  const handleSelectPersona = useCallback((personaId: string) => {
    if (!personaId) return;
    const selected = personaLibrary.find(p => p.id === personaId);
    if (selected) {
      setChatState(prev => ({ ...prev, general: selected.history }));
      setChatMode('general');
    }
  }, [personaLibrary]);

  const handleFileChange = useCallback((e: ChangeEvent<HTMLInputElement>, mode: 'general' | 'rag') => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (mode === 'general') {
      setImageFile(file);
      setImagePreview(URL.createObjectURL(file));
    } else {
      setRagFile(file);
      setChatState(prev => ({ ...prev, rag: [] })); // New document, new session
    }
  }, []);

  const removeImage = useCallback(() => {
    setImageFile(null);
    setImagePreview(null);
    if (fileInputRefs.general.current) fileInputRefs.general.current.value = "";
  }, []);

  // REASON: สร้างฟังก์ชันกลางสำหรับจัดการ Streaming API Call เพื่อลดโค้ดซ้ำซ้อน
  const streamApiCall = async (endpoint: string, formData: FormData) => {
    setIsLoading(true);

    const userMessageText = chatMode === 'general'
      ? (imageFile ? `[Image: ${imageFile.name}] ${prompt}` : prompt)
      : prompt;

    // Add user message and prepare for AI response
    setChatState(prev => {
        const newHistory = [...prev[chatMode], { sender: 'user', text: userMessageText }];
        // For Agent mode, add a "Thinking" placeholder immediately
        if (chatMode === 'agent') {
            newHistory.push({ sender: 'ai', text: '', type: 'thought' });
        } else {
            newHistory.push({ sender: 'ai', text: '' });
        }
        return { ...prev, [chatMode]: newHistory };
    });
    setPrompt('');
    if (chatMode === 'general') removeImage();

    try {
        const response = await fetch(`${BACKEND_URL}${endpoint}`, { method: 'POST', body: formData });
        if (!response.body) throw new Error("Response body is null.");

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value, { stream: true });
            const lines = chunk.split('\n\n');

            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    try {
                        const dataStr = line.substring(6);
                        if (!dataStr.trim()) continue;
                        const data = JSON.parse(dataStr);

                        if (data.error) {
                            throw new Error(data.error);
                        }

                        if (data.text) {
                            setChatState(prev => {
                                const newHistory = [...prev[chatMode]];
                                let lastMessage = newHistory[newHistory.length - 1];

                                if (!lastMessage || lastMessage.sender !== 'ai') return prev; // Safety check

                                if (chatMode === 'agent') {
                                    if (data.type === 'thought' && lastMessage.type === 'thought') {
                                        lastMessage.text += data.text;
                                    } else if (data.type === 'final_answer_chunk') {
                                        // If the last message was a thought, replace it with a final answer message
                                        if (lastMessage.type === 'thought') {
                                            newHistory.push({ sender: 'ai', text: data.text, type: 'final_answer' });
                                        } else { // otherwise, append to the existing final answer
                                            lastMessage.text += data.text;
                                        }
                                    }
                                } else {
                                    lastMessage.text += data.text;
                                }

                                return { ...prev, [chatMode]: newHistory };
                            });
                        }
                    } catch (e) {
                        console.error("Error parsing stream data:", e);
                    }
                }
            }
        }
    } catch (error) {
        console.error(`Error fetching from ${endpoint}:`, error);
        setChatState(prev => {
            const newHistory = [...prev[chatMode]];
            let lastMessage = newHistory[newHistory.length - 1];
            if (lastMessage?.sender === 'ai') {
                lastMessage.text = `Sorry, a connection error occurred: ${error instanceof Error ? error.message : 'Unknown error'}`;
            }
            return { ...prev, [chatMode]: newHistory };
        });
    } finally {
        setIsLoading(false);
    }
};

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (isLoading || !prompt.trim()) return;

    const formData = new FormData();
    formData.append('model', selectedModel);

    if (chatMode === 'general') {
      formData.append('history', JSON.stringify(chatState.general));
      formData.append('prompt', prompt);
      if (imageFile) formData.append('image', imageFile);
      await streamApiCall('/api/generate-stream', formData);
    }
    else if (chatMode === 'rag') {
      if (!ragFile) { alert("Please select a PDF document first."); return; }
      formData.append('question', prompt);
      formData.append('file', ragFile);
      await streamApiCall('/api/ask-document-stream', formData);
    }
    else if (chatMode === 'agent') {
      formData.append('question', prompt);
      await streamApiCall('/api/run-agent-stream', formData);
    }
  };


  // --- RENDER LOGIC ---
  const currentChatHistory = chatState[chatMode];

  // This part would be a separate <Header /> component
  const renderHeader = () => (
    <div className="app-header">
      <div className="mode-toggle">
        <button onClick={() => handleModeChange('general')} className={chatMode === 'general' ? 'active' : ''}>Chat</button>
        <button onClick={() => handleModeChange('rag')} className={chatMode === 'rag' ? 'active' : ''}>Document</button>
        <button onClick={() => handleModeChange('agent')} className={chatMode === 'agent' ? 'active' : ''}>Agent</button>
      </div>
      <div className="header-controls">
        <select onChange={e => handleSelectPersona(e.target.value)} value="" className="persona-selector">
          <option value="" disabled>-- Change Persona --</option>
          {personaLibrary.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
        </select>
        <select value={selectedModel} onChange={e => setSelectedModel(e.target.value)} disabled={isLoading} className="model-selector">
          {AVAILABLE_MODELS.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}
        </select>
      </div>
    </div>
  );

  // This part would be a separate <ChatWindow /> component
  const renderChatWindow = () => (
    <div className="chat-window" ref={chatWindowRef}>
      {currentChatHistory.map((msg, index) => (
        <div key={index} className={`message ${msg.sender} ${msg.type === 'thought' ? 'thought-message' : ''}`}>
          {msg.type === 'thought' && <span className="thought-label">Thinking...</span>}
          <ReactMarkdown>{msg.text}</ReactMarkdown>
        </div>
      ))}
      {isLoading && currentChatHistory[currentChatHistory.length - 1]?.sender === 'user' && (
        <div className="message ai"><div className="typing-indicator"><span></span><span></span><span></span></div></div>
      )}
    </div>
  );
  
  // This part would be a separate <InputArea /> component
  const renderInputArea = () => (
     <div className="input-area">
      {chatMode === 'rag' && (
        <div className="file-controls">
          <button onClick={() => fileInputRefs.rag.current?.click()} className="upload-btn">
            {ragFile ? `✔ ${ragFile.name}` : 'Select PDF Document'}
          </button>
          <input type="file" ref={fileInputRefs.rag} onChange={(e) => handleFileChange(e, 'rag')} accept=".pdf" style={{ display: 'none' }} />
        </div>
      )}
      {chatMode === 'general' && imagePreview && (
        <div className="image-preview-container">
          <img src={imagePreview} alt="Preview" className="image-preview" />
          <button onClick={removeImage} className="remove-image-btn">&times;</button>
        </div>
      )}
      <form className="chat-input-form" onSubmit={handleSubmit}>
        {chatMode === 'general' && (
          <>
            <button type="button" onClick={() => fileInputRefs.general.current?.click()} className="attach-btn" title="Attach Image">📎</button>
            <input type="file" ref={fileInputRefs.general} onChange={(e) => handleFileChange(e, 'general')} accept="image/*" style={{ display: 'none' }} />
          </>
        )}
        <input
          type="text"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder={
            chatMode === 'agent' ? 'Give me a complex task...' :
            chatMode === 'rag' ? (ragFile ? 'Ask about the document...' : 'Please select a document first.') :
            'Ask anything...'
          }
          disabled={isLoading || (chatMode === 'rag' && !ragFile)}
        />
        <button type="submit" disabled={isLoading || !prompt.trim()}>Send</button>
      </form>
    </div>
  );

  return (
    <div className="app-container">
      {renderHeader()}
      {renderChatWindow()}
      {renderInputArea()}
    </div>
  );
}

export default App;