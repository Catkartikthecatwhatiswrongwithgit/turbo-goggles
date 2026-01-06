
export type Emotion = 'neutral' | 'happy' | 'concerned' | 'thinking';

export interface Message {
  id: string;
  role: 'user' | 'leo';
  text: string;
  timestamp: number;
  sources?: { uri: string; title: string }[];
  isSearching?: boolean;
  imageUrl?: string;
}

export interface LeoState {
  emotion: Emotion;
  isSpeaking: boolean;
  isThinking: boolean;
  isLive: boolean;
}
