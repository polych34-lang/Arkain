import { DESIGN_TOKENS_CSS } from "./layout.js";

/** ARK-86: 담당자에게 전달받은 재설정 코드 + 새 비밀번호 입력 화면.
 * forgotPassword.ts의 요청 단계와 짝을 이루는 소비 단계. */
export function renderResetPassword(): string {
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<title>ARKAIN — 새 비밀번호 설정</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
${DESIGN_TOKENS_CSS}
  body { display: flex; align-items: center; justify-content: center; min-height: 100vh; }
  .auth-card { width: 100%; max-width: 420px; background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 2rem 2rem 1.75rem; }
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
    <h1>새 비밀번호 설정</h1>
    <label for="token">재설정 코드</label>
    <input id="token" placeholder="전달받은 재설정 코드" autocomplete="off" />
    <label for="password">새 비밀번호 (8자 이상)</label>
    <input id="password" type="password" placeholder="********" />
    <button id="submit" type="button">비밀번호 변경</button>
    <div id="msg"></div>
    <p class="muted"><a href="/login">로그인으로 돌아가기</a></p>
  </div>

  <script>
    document.querySelector("#submit").addEventListener("click", async () => {
      const msg = document.querySelector("#msg");
      const token = document.querySelector("#token").value.trim();
      const password = document.querySelector("#password").value;
      if (!token || !password) {
        msg.innerHTML = '<span class="badge err">재설정 코드와 새 비밀번호를 입력해주세요</span>';
        return;
      }
      msg.textContent = "변경 중…";
      try {
        const res = await fetch("/api/auth/forgot-password/reset", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token, password }),
        });
        const data = await res.json();
        if (!res.ok) {
          msg.innerHTML = '<span class="badge err">' + (data.error ?? "변경 실패") + "</span>";
          return;
        }
        msg.innerHTML = '<span class="badge ok">비밀번호가 변경되었습니다. 로그인해주세요.</span>';
      } catch (err) {
        msg.innerHTML = '<span class="badge err">변경 실패</span> ' + err;
      }
    });
  </script>
</body>
</html>`;
}
