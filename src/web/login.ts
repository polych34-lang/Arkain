import { DESIGN_TOKENS_CSS } from "./layout.js";

/**
 * ARK-57 로그인, ARK-72 회사코드/계정/비밀번호 3-필드 구조. Same plain
 * server-rendered HTML + vanilla JS posture as signup.ts / ordersDashboard.ts.
 */
export function renderLogin(): string {
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<title>ARKAIN — 로그인</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
${DESIGN_TOKENS_CSS}
  body { display: flex; align-items: center; justify-content: center; min-height: 100vh; }
  .auth-card { width: 100%; max-width: 380px; background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 2rem 2rem 1.75rem; }
  .brand { font-weight: 700; font-size: 1.2rem; color: var(--brand); margin-bottom: 0.25rem; }
  h1 { font-size: 1.05rem; color: var(--ink-muted); font-weight: 500; margin-bottom: 1.25rem; }
  button { width: 100%; margin-top: 0.9rem; }
  #msg { margin-top: 0.6rem; font-size: 0.9rem; }
  .muted { margin-top: 1.25rem; text-align: center; }
</style>
</head>
<body>
  <div class="auth-card">
    <div class="brand">ARKAIN</div>
    <h1>업체 워크스페이스 로그인</h1>

    <label for="companyCode">회사코드</label>
    <input id="companyCode" placeholder="예: A1B2C3" autocomplete="off" />
    <label for="email">계정 (이메일)</label>
    <input id="email" type="email" placeholder="you@example.com" />
    <label for="password">비밀번호</label>
    <input id="password" type="password" placeholder="********" />
    <button id="submit" type="button">로그인</button>
    <div id="msg"></div>
    <p class="muted">아직 워크스페이스가 없으신가요? <a href="/signup">워크스페이스 만들기</a></p>
  </div>

  <script>
    document.querySelector("#submit").addEventListener("click", async () => {
      const msg = document.querySelector("#msg");
      const companyCode = document.querySelector("#companyCode").value.trim();
      const email = document.querySelector("#email").value.trim();
      const password = document.querySelector("#password").value;
      if (!companyCode || !email || !password) {
        msg.innerHTML = '<span class="badge err">회사코드, 이메일, 비밀번호를 모두 입력해주세요</span>';
        return;
      }
      msg.textContent = "로그인 중…";
      try {
        const res = await fetch("/api/auth/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ companyCode, email, password }),
        });
        const data = await res.json();
        if (!res.ok) {
          msg.innerHTML = '<span class="badge err">' + (data.error ?? "로그인 실패") + "</span>";
          return;
        }
        location.href = "/products";
      } catch (err) {
        msg.innerHTML = '<span class="badge err">로그인 실패</span> ' + err;
      }
    });
  </script>
</body>
</html>`;
}
