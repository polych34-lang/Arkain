import { DESIGN_TOKENS_CSS } from "./layout.js";

/**
 * ARK-57: 워크스페이스 생성 (sign-up). One form creates both the seller's
 * login credential and their `Seller` (workspace) row — see the doc comment
 * on `Seller.email` in schema.prisma for why sign-up and workspace-creation
 * are the same action in this MVP. ARK-72: sign-up also issues a 회사코드,
 * shown once here so the seller can save it before it's needed at every
 * future login.
 */
export function renderSignup(): string {
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<title>ARKAIN — 회원가입</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
${DESIGN_TOKENS_CSS}
  body { display: flex; align-items: center; justify-content: center; min-height: 100vh; }
  .auth-card { width: 100%; max-width: 420px; background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 2rem 2rem 1.75rem; }
  .brand { font-weight: 700; font-size: 1.2rem; color: var(--brand); margin-bottom: 0.25rem; }
  h1 { font-size: 1.05rem; color: var(--ink-muted); font-weight: 500; margin-bottom: 0.25rem; }
  button { width: 100%; margin-top: 0.9rem; }
  #msg { margin-top: 0.6rem; font-size: 0.9rem; }
  .muted { margin-top: 1.25rem; text-align: center; }
  #successCard { display: none; }
  .company-code-box {
    text-align: center; background: var(--brand-soft); border: 1px dashed var(--brand);
    border-radius: 10px; padding: 1.25rem; margin: 1rem 0;
  }
  .company-code-box .code { font-size: 1.6rem; font-weight: 700; letter-spacing: 0.15em; color: var(--brand-dark); }
</style>
</head>
<body>
  <div class="auth-card" id="formCard">
    <div class="brand">ARKAIN</div>
    <h1>워크스페이스 만들기</h1>
    <p class="muted" style="margin-top:0;text-align:left;">사업체(워크스페이스) 이름과 로그인 정보를 입력하면 바로 시작할 수 있습니다.</p>

    <label for="workspaceName">워크스페이스 이름</label>
    <input id="workspaceName" placeholder="예: 아카인 상회" />
    <label for="email">이메일</label>
    <input id="email" type="email" placeholder="you@example.com" />
    <label for="password">비밀번호 (8자 이상)</label>
    <input id="password" type="password" placeholder="********" />
    <button id="submit" type="button">워크스페이스 만들기</button>
    <div id="msg"></div>
    <p class="muted">이미 계정이 있으신가요? <a href="/login">로그인</a></p>
  </div>

  <div class="auth-card" id="successCard">
    <div class="brand">ARKAIN</div>
    <h1>워크스페이스가 만들어졌습니다</h1>
    <p class="muted" style="margin-top:0;text-align:left;">
      아래 <strong>회사코드</strong>는 다음 로그인부터 계속 필요합니다. 꼭 저장해두세요.
    </p>
    <div class="company-code-box">
      <div class="muted" style="margin-top:0;">회사코드</div>
      <div class="code" id="companyCodeOut"></div>
    </div>
    <p class="muted" style="margin-top:0;text-align:left;">
      회사코드를 잊어버리면 로그인 화면에서 이메일로 다시 찾을 수 있습니다.
    </p>
    <button id="proceed" type="button">시작하기</button>
  </div>

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
        document.querySelector("#companyCodeOut").textContent = data.companyCode;
        document.querySelector("#formCard").style.display = "none";
        document.querySelector("#successCard").style.display = "block";
      } catch (err) {
        msg.innerHTML = '<span class="badge err">가입 실패</span> ' + err;
      }
    });

    document.querySelector("#proceed").addEventListener("click", () => {
      location.href = "/products";
    });
  </script>
</body>
</html>`;
}
