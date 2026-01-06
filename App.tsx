
import React, { useState, useCallback, useRef, useEffect } from 'react';
import { Message, Emotion, LeoState } from './types';
import Avatar from './components/Avatar';
import ChatBox from './components/ChatBox';
import { 
  getGeminiClient, 
  chatWithLeoStream, 
  generateLeoImage, 
  LEO_SYSTEM_INSTRUCTION,
  encodeAudio,
  decodeAudio,
  decodeAudioBuffer
} from './services/geminiService';
import { Send, Settings, Terminal, Mic, MicOff, Sparkles, Zap } from 'lucide-react';
import { Modality } from '@google/genai';

const App: React.FC = () => {
  const [messages, setMessages] = useState<Message[]>([
    {
      id: 'welcome',
      role: 'leo',
      text: "Yo. I'm Leo. Think of me as your smart, slightly chaotic friend who actually has a personality. Want to chat, argue, or see me visualize something wild?",
      timestamp: Date.now()
    }
  ]);
  const [input, setInput] = useState('');
  const [leoState, setLeoState] = useState<LeoState>({
    emotion: 'neutral',
    isSpeaking: false,
    isThinking: false,
    isLive: false
  });
  const [showSettings, setShowSettings] = useState(false);

  const inputAudioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const liveSessionRef = useRef<Promise<any> | null>(null);
  const nextStartTimeRef = useRef(0);
  const activeSources = useRef<Set<AudioBufferSourceNode>>(new Set());

  const initAudioContexts = () => {
    if (!inputAudioContextRef.current) {
      inputAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
    }
    if (!outputAudioContextRef.current) {
      outputAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
    }
    [inputAudioContextRef.current, outputAudioContextRef.current].forEach(ctx => {
      if (ctx.state === 'suspended') ctx.resume();
    });
  };

  const toggleLive = async () => {
    if (leoState.isLive) {
      window.location.reload(); // Hard reset for clean session closure
      return;
    }

    initAudioContexts();
    const ai = getGeminiClient();
    
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-09-2025',
        callbacks: {
          onopen: () => {
            setLeoState(prev => ({ ...prev, isLive: true, emotion: 'happy' }));
            
            const source = inputAudioContextRef.current!.createMediaStreamSource(stream);
            const scriptProcessor = inputAudioContextRef.current!.createScriptProcessor(4096, 1, 1);
            
            scriptProcessor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              const pcmBlob = {
                data: encodeAudio(inputData),
                mimeType: 'audio/pcm;rate=16000'
              };
              sessionPromise.then(session => {
                session.sendRealtimeInput({ media: pcmBlob });
              });
            };
            
            source.connect(scriptProcessor);
            scriptProcessor.connect(inputAudioContextRef.current!.destination);
          },
          onmessage: async (msg) => {
            // Handle Interruption
            if (msg.serverContent?.interrupted) {
              activeSources.current.forEach(source => source.stop());
              activeSources.current.clear();
              nextStartTimeRef.current = 0;
              return;
            }

            const parts = msg.serverContent?.modelTurn?.parts;
            const audioData = parts?.[0]?.inlineData?.data;

            if (audioData && outputAudioContextRef.current) {
              const bytes = decodeAudio(audioData);
              const buffer = await decodeAudioBuffer(bytes, outputAudioContextRef.current);
              
              const source = outputAudioContextRef.current.createBufferSource();
              source.buffer = buffer;
              source.connect(outputAudioContextRef.current.destination);
              
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, outputAudioContextRef.current.currentTime);
              source.start(nextStartTimeRef.current);
              nextStartTimeRef.current += buffer.duration;
              
              activeSources.current.add(source);
              setLeoState(prev => ({ ...prev, isSpeaking: true }));
              
              source.onended = () => {
                activeSources.current.delete(source);
                if (activeSources.current.size === 0) {
                  setLeoState(prev => ({ ...prev, isSpeaking: false }));
                }
              };
            }
          },
          onerror: (e) => console.error("Live Error:", e),
          onclose: () => setLeoState(prev => ({ ...prev, isLive: false }))
        },
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Charon' } } },
          systemInstruction: LEO_SYSTEM_INSTRUCTION
        }
      });
      liveSessionRef.current = sessionPromise;
    } catch (err) {
      console.error("Mic Access Failed:", err);
    }
  };

  const handleSend = async (textOverride?: string) => {
    const textToSend = textOverride || input;
    if (!textToSend.trim() || leoState.isThinking) return;

    initAudioContexts();
    const userMsg: Message = { id: Date.now().toString(), role: 'user', text: textToSend, timestamp: Date.now() };
    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setLeoState(prev => ({ ...prev, isThinking: true }));

    // Image Trigger Logic
    const isImageReq = /generate|visualize|create|show me/i.test(textToSend);
    if (isImageReq) {
      try {
        const imageUrl = await generateLeoImage(textToSend);
        if (imageUrl) {
          setMessages(prev => [...prev, { 
            id: Date.now().toString(), 
            role: 'leo', 
            text: "Boom. Here's that visualization you wanted. Absolute fire.", 
            timestamp: Date.now(),
            imageUrl 
          }]);
          setLeoState(prev => ({ ...prev, isThinking: false, emotion: 'happy' }));
          return;
        }
      } catch (e) { console.error(e); }
    }

    const leoId = Date.now().toString();
    setMessages(prev => [...prev, { id: leoId, role: 'leo', text: '', timestamp: Date.now() }]);

    try {
      const history = messages.slice(-6).map(m => ({
        role: m.role === 'leo' ? 'model' : 'user',
        parts: [{ text: m.text }]
      }));

      const stream = chatWithLeoStream(textToSend, history);
      let fullText = '';
      setLeoState(prev => ({ ...prev, isThinking: false, emotion: 'neutral' }));

      for await (const chunk of stream) {
        fullText += chunk;
        setMessages(prev => prev.map(m => m.id === leoId ? { ...m, text: fullText } : m));
      }
    } catch (error) {
      setLeoState(prev => ({ ...prev, isThinking: false, emotion: 'concerned' }));
    }
  };

  return (
    <div className="flex flex-col h-screen bg-[#0D0D0D] text-[#EAEAEA] selection:bg-[#FF4C4C] selection:text-white">
      {/* Header */}
      <header className="flex items-center justify-between p-4 border-b border-[#222] bg-[#141414] z-10 shadow-xl">
        <div className="flex items-center gap-3">
          <div className={`w-10 h-10 rounded-full bg-[#3D0000] border border-[#FF4C4C] flex items-center justify-center transition-all ${leoState.isLive ? 'shadow-[0_0_25px_rgba(255,76,76,0.6)] animate-pulse' : 'shadow-lg'}`}>
            <Zap className={leoState.isLive ? 'text-white' : 'text-[#FF4C4C]'} size={20} />
          </div>
          <div>
            <h1 className="text-xl font-black tracking-tighter text-white leading-none">LEO.LIVE</h1>
            <p className="text-[9px] text-[#FFB6C1] uppercase tracking-[0.2em] font-bold">Witty • Human • Real</p>
          </div>
        </div>
        <div className="flex gap-2">
          <button 
            onClick={toggleLive}
            className={`flex items-center gap-2 px-4 py-2 rounded-full font-bold text-xs transition-all ${leoState.isLive ? 'bg-[#FF4C4C] text-white' : 'bg-[#1A1A1A] border border-[#333] text-gray-400 hover:border-[#FF4C4C] hover:text-[#FF4C4C]'}`}
          >
            {leoState.isLive ? <Mic size={16} /> : <MicOff size={16} />}
            {leoState.isLive ? 'LIVE' : 'GO LIVE'}
          </button>
          <button onClick={() => setShowSettings(!showSettings)} className="p-2 hover:bg-[#222] rounded-full text-gray-400">
            <Settings size={20} />
          </button>
        </div>
      </header>

      {/* Main Container */}
      <main className="flex-1 flex flex-col md:flex-row overflow-hidden relative">
        {/* Profile/Avatar Section */}
        <div className="flex flex-col items-center justify-center p-8 md:w-80 lg:w-96 border-b md:border-b-0 md:border-r border-[#222] bg-gradient-to-b from-[#141414] to-[#0D0D0D]">
          <Avatar emotion={leoState.emotion} isSpeaking={leoState.isSpeaking} isThinking={leoState.isThinking} />
          <div className="mt-10 text-center max-w-xs">
             <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-[#FF4C4C]/10 border border-[#FF4C4C]/30 text-[#FF4C4C] text-[10px] font-black uppercase mb-4 tracking-widest">
               <Sparkles size={12} /> Personality Active
             </div>
             <p className="text-xs text-gray-500 italic leading-relaxed">"Honestly, most AI is boring. Let's make this interesting."</p>
          </div>
        </div>

        {/* Chat Interface */}
        <div className="flex-1 flex flex-col bg-[#0A0A0A] overflow-hidden">
          <ChatBox messages={messages} onSpeak={() => {}} onVerify={(t) => handleSend(`Double check this fact for me, Leo: "${t}"`)} />
          
          <div className="p-6 border-t border-[#222] bg-[#111]">
            <form onSubmit={(e) => { e.preventDefault(); handleSend(); }} className="relative flex items-center max-w-4xl mx-auto w-full group">
              <input 
                type="text"
                value={input}
                onFocus={initAudioContexts}
                onChange={(e) => setInput(e.target.value)}
                placeholder={leoState.isLive ? "I'm listening..." : "Say something witty..."}
                className="w-full bg-[#1A1A1A] border border-[#333] focus:border-[#FF4C4C] rounded-2xl px-6 py-5 pr-16 text-sm outline-none transition-all placeholder:text-gray-600 shadow-2xl group-focus-within:ring-1 ring-[#FF4C4C]/20"
              />
              <button 
                type="submit"
                disabled={!input.trim() || leoState.isThinking}
                className="absolute right-3 p-3 bg-[#FF4C4C] hover:bg-[#FF6666] text-white rounded-xl transition-all disabled:opacity-10 shadow-lg"
              >
                <Send size={18} />
              </button>
            </form>
          </div>
        </div>
      </main>
    </div>
  );
};

export default App;
