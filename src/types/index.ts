export interface Message {
  id: string;
  speaker: string;
  content: string;
  timestamp: number;
  replyTo?: string;
  status?: "accepted" | "dropped";
}

export interface AgentPersona {
  name: string;
  role: string;
  a2aUrl: string;
  color: string;
}

export interface Thread {
  id: string;
  name: string;
  agents: AgentPersona[];
  createdAt: number;
  updatedAt: number;
  userId?: string;
}

export interface ThreadAgent {
  id: string;
  name: string;
  role: string;
  a2aUrl: string;
  color: string;
}
