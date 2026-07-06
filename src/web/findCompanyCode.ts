import { DESIGN_TOKENS_CSS } from "./layout.js";

/**
 * ARK-86: 회사코드 찾기. 이메일 소유 확인 없이 조회를 허용하는 것은 이 이슈의
 * 명시적 결정 — 회사코드는 그 자체로 로그인을 허용하지 않고(이메일+비밀번호가
 * 항상 같이 필요) 항상 존재하는 것으로 취급해도 되는 정보라, 이메일만으로
 * 조회 가능하게 하고 대신 무차별 대입/전수 조회 방지용 rate limit
 * (`POST /api/auth/find-company-code`, src/app.ts)으로 막는다. 비밀번호
 * 재설정(forgotPassword.ts)은 계정 탈취로 이어지므로 같은 방식을 쓰지 않는다.
 */
export function renderFindCompanyCode(): string {
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<title>ARKAIN — 회사코드 찾기</title>
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
  #resultCard { display: none; }
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
    <h1>회사코드 찾기</h1>
    <label for="email">가입하신 이메일</label>
    <input id="email" type="email" placeholder="you@example.com" />
    <button id="submit" type="button">회사코드 확인</button>
    <div id="msg"></div>
    <p class="muted"><a href="/login">로그인으로 돌아가기</a></p>
  </div>

  <div class="auth-card" id="resultCard">
    <div class="brand">ARKAIN</div>
    <h1>회사코드를 확인했습니다</h1>
    <div class="company-code-box">
      <div class="muted" style="margin-top:0;">회사코드</div>
      <div class="code" id="companyCodeOut"></div>
    </div>
    <a class="button" href="/login" style="display:block; text-align:center; text-decoration:none;">로그인하러 가기</a>
  </div>

  <script>
    document.querySelector("#submit").addEventListener("click", async () => {
      const msg = document.querySelector("#msg");
      const email = document.querySelector("#email").value.trim();
      if (!email) {
        msg.innerHTML = '<span class="badge err">이메일을 입력해주세요</span>';
        return;
      }
      msg.textContent = "확인 중…";
      try {
        const res = await fetch("/api/auth/find-company-code", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email }),
        });
        const data = await res.json();
        if (!res.ok) {
          msg.innerHTML = '<span class="badge err">' + (data.error ?? "조회 실패") + "</span>";
          return;
        }
        document.querySelector("#companyCodeOut").textContent = data.companyCode;
        document.querySelector("#formCard").style.display = "none";
        document.querySelector("#resultCard").style.display = "block";
      } catch (err) {
        msg.innerHTML = '<span class="badge err">조회 실패</span> ' + err;
      }
    });
  </script>
</body>
</html>`;
}
