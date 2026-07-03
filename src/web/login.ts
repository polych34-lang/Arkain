/**
 * ARK-57: 로그인. Same plain server-rendered HTML + vanilla JS posture as
 * signup.ts / ordersDashboard.ts.
 */
export function renderLogin(): string {
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<title>ARKAIN — 로그인</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  body { font-family: -apple-system, "Malgun Gothic", sans-serif; margin: 2rem auto; max-width: 420px; color: #1a1a1a; }
  h1 { font-size: 1.25rem; }
  label { display: block; font-size: 0.85rem; color: #444; margin-top: 0.75rem; }
  input { padding: 0.4rem 0.6rem; font-size: 0.9rem; width: 100%; box-sizing: border-box; margin: 0.25rem 0 0.5rem; }
  button { cursor: pointer; padding: 0.5rem 1rem; font-size: 0.9rem; margin-top: 0.5rem; }
  .badge { display: inline-block; padding: 0.1rem 0.5rem; border-radius: 999px; font-size: 0.75rem; }
  .badge.err { background: #fdeaea; color: #c62828; }
  #msg { margin-top: 0.5rem; font-size: 0.9rem; }
  .muted { color: #888; font-size: 0.85rem; }
</style>
</head>
<body>
  <h1>ARKAIN 로그인</h1>

  <label for="email">이메일</label>
  <input id="email" type="email" placeholder="you@example.com" />
  <label for="password">비밀번호</label>
  <input id="password" type="password" placeholder="********" />
  <button id="submit" type="button">로그인</button>
  <div id="msg"></div>
  <p class="muted">아직 워크스페이스가 없으신가요? <a href="/signup">워크스페이스 만들기</a></p>

  <script>
    document.querySelector("#submit").addEventListener("click", async () => {
      const msg = document.querySelector("#msg");
      const email = document.querySelector("#email").value.trim();
      const password = document.querySelector("#password").value;
      if (!email || !password) {
        msg.innerHTML = '<span class="badge err">이메일과 비밀번호를 입력해주세요</span>';
        return;
      }
      msg.textContent = "로그인 중…";
      try {
        const res = await fetch("/api/auth/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email, password }),
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
