import type { FastifyRequest } from "fastify";
import type { Pool } from "./db.ts";

export class HttpError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message?: string) {
    super(message ?? code);
    this.status = status;
    this.code = code;
  }
}

export interface Auth { userId: string; tenantId: string; role: string; status: string; trialEnds: Date | null }

export interface Ctx {
  pool: Pool;
  authenticate(req: FastifyRequest): Promise<Auth>;
  needRole(a: Auth, roles: string[]): void;
  needModule(a: Auth, moduleId: string): Promise<void>;
}

export const WRITE = ["owner", "admin", "manager", "member"]; // everyone but viewer
export const FINANCE = ["owner", "admin", "manager"]; // may record payments, void
