import { useState, type FormEvent, useEffect, useRef, type ChangeEvent } from 'react';
import ReactMarkdown from 'react-markdown';
import './App.css';
import axios from 'axios';

// --- Interfaces ---
interface Message {
  sender: 'user' | 'ai';
  text: string;
}

interface PersonaTemplate {
  id: string;
  title: string;
  history: Message[];
}

// --- Constants ---
const availableModels = [
  { id: 'gemini-1.5-flash-latest', name: 'Gemini 1.5 Flash (เร็ว)' },
  { id: 'gemini-2.5-flash', name: 'Gemini 2.5 flash (เฉียบ)' },
  { id: 'gemini-2.0-flash', name: 'Gemini 2.0 flash (ฉลาดเร็ว)' },
  { id: 'gemini-2.5-pro', name: 'Gemini 2.5 pro (ฉลาดสุขุม)' },
];

// !!! =============================================================== !!!
// !!! ==> โปรดแก้ไข URL นี้ให้เป็น URL ของ Backend บน Render.com <== !!!
// !!! =============================================================== !!!
const BACKEND_URL = 'https://genai-chatapp-backend.onrender.com';


// --- Main App Component ---
function App() {
  // --- States ---

  // General application state
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [selectedModel, setSelectedModel] = useState<string>(availableModels[0].id);
  const [personaLibrary, setPersonaLibrary] = useState<PersonaTemplate[]>([]);

  // Mode switching state: 'general' for normal chat, 'rag' for document chat
  const [chatMode, setChatMode] = useState<'general' | 'rag'>('general');

  // State for General Chat mode
  const [generalChatHistory, setGeneralChatHistory] = useState<Message[]>([]);
  const [generalPrompt, setGeneralPrompt] = useState<string>('');
  const [generalImageFile, setGeneralImageFile] = useState<File | null>(null);
  const [generalImagePreview, setGeneralImagePreview] = useState<string | null>(null);

  // State for RAG (Ask Document) mode
  const [ragChatHistory, setRagChatHistory] = useState<Message[]>([]);
  const [ragPrompt, setRagPrompt] = useState<string>('');
  const [ragFile, setRagFile] = useState<File | null>(null);
  const [ragFileName, setRagFileName] = useState<string>('');

  // --- Refs for DOM elements ---
  const chatWindowRef = useRef<HTMLDivElement>(null);
  const generalFileInputRef = useRef<HTMLInputElement>(null);
  const ragFileInputRef = useRef<HTMLInputElement>(null);


  // --- useEffect Hooks ---

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

  // Auto-scroll the chat window to the bottom whenever the history changes
  useEffect(() => {
    if (chatWindowRef.current) {
      chatWindowRef.current.scrollTop = chatWindowRef.current.scrollHeight;
    }
  }, [generalChatHistory, ragChatHistory, isLoading]);


  // --- Event Handlers ---

  // Handles switching between 'general' and 'rag' modes
  const handleModeChange = (mode: 'general' | 'rag') => {
    setChatMode(mode);
  };
  
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
  
  // Handles image selection for the General mode
  const handleGeneralImageChange = (e: ChangeEvent<HTMLInputElement>) => {
     if (e.target.files && e.target.files[0]) {
      const file = e.target.files[0];
      setGeneralImageFile(file);
      setGeneralImagePreview(URL.createObjectURL(file));
    }
  };
  
  const removeGeneralImage = () => {
    setGeneralImageFile(null);
    setGeneralImagePreview(null);
    if (generalFileInputRef.current) generalFileInputRef.current.value = "";
  };

  // Main submit handler that delegates to the correct mode-specific handler
  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (isLoading) return;

    if (chatMode === 'general') {
      await handleGeneralSubmit();
    } else {
      await handleRagSubmit();
    }
  };

  // --- API Call Logic ---
  
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
                              if (lastMessage?.sender === 'ai') {
                                  lastMessage.text = (lastMessage.text || '') + data.text;
                              } else {
                                  newHistory.push({ sender: 'ai', text: data.text });
                              }
                              return newHistory;
                            });
                            }

                        else if (data.error) {
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

    setRagChatHistory(prev => [...prev, { sender: 'user', text: ragPrompt }, { sender: 'ai', text: '' }]);
    setRagPrompt('');

    try {
      const response = await fetch(`${BACKEND_URL}/api/ask-document-stream`, {
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
                setRagChatHistory(prev => {
                  const newHistory = [...prev];
                  const lastMessage = newHistory[newHistory.length - 1];
                  if (lastMessage?.sender === 'ai') {
                    lastMessage.text += data.text;
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
            }
          }
        }
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

  // --- Render Logic ---

  // Dynamically determine which state to use based on the current chat mode
  const currentChatHistory = chatMode === 'general' ? generalChatHistory : ragChatHistory;
  const currentPrompt = chatMode === 'general' ? generalPrompt : ragPrompt;
  const setCurrentPrompt = chatMode === 'general' ? setGeneralPrompt : setRagPrompt;

  return (
    <div className="app-container">
      {/* --- Header Area --- */}
      <div className="app-header">
        <div className="mode-toggle">
          <button onClick={() => handleModeChange('general')} className={chatMode === 'general' ? 'active' : ''}>General Chat</button>
          <button onClick={() => handleModeChange('rag')} className={chatMode === 'rag' ? 'active' : ''}>Ask Document</button>
        </div>
        <div className="header-controls">
          <select onChange={e => handleSelectPersona(e.target.value)} value="">
            <option value="" disabled>-- Change Persona --</option>
            {personaLibrary.map((p) => (<option key={p.id} value={p.id}>{p.title}</option>))}
          </select>
          <select value={selectedModel} onChange={e => setSelectedModel(e.target.value)} disabled={isLoading}>
            {availableModels.map(model => (<option key={model.id} value={model.id}>{model.name}</option>))}
          </select>
        </div>
      </div>

      {/* --- Chat Display Area --- */}
      <div className="chat-window" ref={chatWindowRef}>
        {currentChatHistory.map((msg, index) => (
          <div key={index} className={`message ${msg.sender}`}>
            <ReactMarkdown>{msg.text}</ReactMarkdown>
          </div>
        ))}
        {isLoading && <div className="message ai"><div className="typing-indicator"><span></span><span></span><span></span></div></div>}
      </div>

      {/* --- Input Area (Dynamically changes based on mode) --- */}
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

        <form className="chat-input-form" onSubmit={handleSubmit}>
          {chatMode === 'general' && (
            <button type="button" onClick={() => generalFileInputRef.current?.click()} className="attach-btn" title="Attach Image">📎</button>
          )}
           <input type="file" ref={generalFileInputRef} onChange={handleGeneralImageChange} accept="image/*" style={{ display: 'none' }} />

          <input
            type="text"
            value={currentPrompt}
            onChange={(e) => setCurrentPrompt(e.target.value)}
            placeholder={
              chatMode === 'rag' 
                ? (ragFile ? 'Ask about the document...' : 'Please select a document.') 
                : 'Ask anything (or attach an image)...'
            }
            disabled={isLoading || (chatMode === 'rag' && !ragFile)}
          />
          <button 
            type="submit" 
            disabled={isLoading || !currentPrompt.trim()}
           >Send</button>
        </form>
      </div>
    </div>
  );
}

export default App;