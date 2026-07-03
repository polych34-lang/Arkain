/**
 * ARK-57: 워크스페이스 생성 (sign-up). One form creates both the seller's
 * login credential and their `Seller` (workspace) row — see the doc comment
 * on `Seller.email` in schema.prisma for why sign-up and workspace-creation
 * are the same action in this MVP. Same plain server-rendered HTML + vanilla
 * JS posture as ordersDashboard.ts (ARK-5) / naverOnboarding.ts (ARK-21).
 */
export function renderSignup(): string {
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<title>ARKAIN — 회원가입</title>
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
  <h1>ARKAIN 워크스페이스 만들기</h1>
  <p class="muted">사업체(워크스페이스) 이름과 로그인 정보를 입력하면 바로 시작할 수 있습니다.</p>

  <label for="workspaceName">워크스페이스 이름</label>
  <input id="workspaceName" placeholder="예: 아카인 상회" />
  <label for="email">이메일</label>
  <input id="email" type="email" placeholder="you@example.com" />
  <label for="password">비밀번호 (8자 이상)</label>
  <input id="password" type="password" placeholder="********" />
  <button id="submit" type="button">워크스페이스 만들기</button>
  <div id="msg"></div>
  <p class="muted">이미 계정이 있으신가요? <a href="/login">로그인</a></p>

  <script>
    document.querySelector("#submit").addEventListener("click", async () => {
      const msg = document.querySelector("#msg");
      const workspaceName = document.querySelector("#workspaceName").value.trim();
      const email = document.querySelector("#email").value.trim();
      const password = document.querySelector("#password").value;
      if (!workspaceName || !email || !password) {
        msg.innerHTML = '<span class="badge err">모든 항목을 입력해주세요</span>';
        return;
      }
      msg.textContent = "만드는 중…";
      try {
        const res = await fetch("/api/auth/signup", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ workspaceName, email, password }),
        });
        const data = await res.json();
        if (!res.ok) {
          msg.innerHTML = '<span class="badge err">' + (data.error ?? "가입 실패") + "</span>";
          return;
        }
        location.href = "/products";
      } catch (err) {
        msg.innerHTML = '<span class="badge err">가입 실패</span> ' + err;
      }
    });
  </script>
</body>
</html>`;
}
