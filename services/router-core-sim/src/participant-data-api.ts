import type { IncomingMessage, ServerResponse } from "node:http";
import { ParticipantDataError, ParticipantDataManager } from "./participant-data.ts";

const paths = new Set(["/api/participant-data/list", "/api/participant-data/delete", "/api/participant-data/delete-diagnostics"]);
export function createParticipantDataHandler(manager: ParticipantDataManager, authorize: (request: IncomingMessage) => void, changed: () => void = () => {}) {
  return async (request: IncomingMessage, response: ServerResponse, pathname: string): Promise<boolean> => {
    if (!paths.has(pathname)) return false;
    const reply = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      response.end(JSON.stringify(body));
    };
    try { authorize(request); } catch { reply(403, { ok: false, error: "このPCの操作画面から実行してください" }); return true; }
    if (request.method !== "POST") { reply(405, { ok: false, error: "POSTが必要です" }); return true; }
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers["content-type"] ?? "") || request.headers["content-encoding"] !== undefined) {
      reply(415, { ok: false, error: "JSONが必要です" }); return true;
    }
    try {
      let size = 0; const chunks: Buffer[] = [];
      for await (const chunk of request) { size += chunk.length; if (size > 4096) throw new ParticipantDataError(413, "要求が大きすぎます"); chunks.push(Buffer.from(chunk)); }
      let body: { confirmed?: unknown; discordUserId?: unknown };
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new ParticipantDataError(400, "JSONの形式が不正です"); }
      if (pathname.endsWith("/list")) reply(200, { ok: true, participants: manager.list() });
      else {
        if (body?.confirmed !== true) throw new ParticipantDataError(400, "削除の確認が必要です");
        if (pathname.endsWith("/delete-diagnostics")) await manager.deleteDiagnostics();
        else await manager.deleteParticipant(body.discordUserId);
        changed();
        reply(200, { ok: true, message: pathname.endsWith("/delete-diagnostics") ? "運用ログと診断ZIPを削除しました" : "参加者データを削除しました" });
      }
    } catch (error) {
      reply(error instanceof ParticipantDataError ? error.status : 500, { ok: false, error: error instanceof ParticipantDataError ? error.message : "データの削除に失敗しました" });
    }
    return true;
  };
}
