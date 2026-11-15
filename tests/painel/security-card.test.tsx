// @vitest-environment jsdom
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { SecurityCard } from "@/app/_design/screens/config/security-card";
import { renderClickable } from "../helpers/click-render";
import { CFG } from "@/app/_design/mock/config";
let view: ReturnType<typeof renderClickable> | undefined;
afterEach(() => { view?.unmount(); });
it("revogação individual em andamento bloqueia outra revogação e o total permanece correto", async () => {
  const deferred = Promise.withResolvers<void>();
  const revoke = vi.fn().mockReturnValue(deferred.promise);
  const others = vi.fn().mockResolvedValue({ count: 2 });
  const sessions = Array.from({ length: 3 }, (_, i) => ({ id: String(i), deviceName: `Dispositivo ${i}`, current: i === 0, createdAt: "hoje", lastSeenAt: "agora" }));
  view = renderClickable(<SecurityCard security={{ ...CFG.security, sessions, sessionsTotal: 3 }} onRevokeSession={revoke} onRevokeOtherSessions={others} />);
  view.click("Revogar");
  view.click("Revogar outras");
  expect(view.container.querySelector('[role="dialog"]')).toBeNull();
  expect(view.container.querySelector<HTMLButtonElement>('button')?.disabled).toBe(true);
  await act(async () => { deferred.resolve(); });
  expect(view.container.textContent).toContain("2 dispositivos autorizados");
  expect(revoke).toHaveBeenCalledOnce();
  expect(others).not.toHaveBeenCalled();
});
