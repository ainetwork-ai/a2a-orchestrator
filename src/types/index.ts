export interface Message {
  id: string;
  speaker: string;
  content: string;
  timestamp: number;
  replyTo?: string;
  status?: "accepted" | "dropped";
  // EPIC8: canonical sender identity for an agent turn ingested from ainspace
  // dual-write. A human turn is identified by speaker === "User" + thread.userId,
  // so it is left unset. Optional → backward-compatible with existing DAG/Redis
  // payloads; the report pipeline does not read it (identity fidelity only).
  senderA2aUrl?: string;
}

export interface AgentPersona {
  name: string;
  role: string;
  a2aUrl: string;
  color: string;
  // EPIC8: the agent's shared-backend users.id, preserved alongside a2aUrl (the
  // A2A protocol identifier the report filter uses) so orchestrator records can
  // be cross-referenced with the backend. Optional → backward-compatible.
  backendAgentId?: string;
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
