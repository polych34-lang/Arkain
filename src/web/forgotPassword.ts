import { DESIGN_TOKENS_CSS } from "./layout.js";

/**
 * ARK-86: 비밀번호 재설정 요청. 회사코드 찾기(findCompanyCode.ts)와 달리 여기서는
 * 재설정 코드를 화면에 바로 보여주지 않는다 — 이메일 소유를 확인할 발송 수단이
 * 없는 상태에서 코드를 그대로 노출하면, 회사코드 찾기(이메일만으로 조회 가능)와
 * 조합했을 때 "이메일 주소만 알면 계정을 통째로 탈취"할 수 있는 구멍이 생긴다
 * (요청 성공/실패와 무관하게 항상 같은 안내를 보여주는 이유도 동일). 대신
 * 요청이 들어오면 담당자에게 알림(ALERT_WEBHOOK_URL)이 가고, 담당자가 본인
 * 확인 후 재설정 코드를 셀러에게 직접 전달한다 — 코드를 받은 다음 단계는
 * /account-recovery/reset. 이메일 발송 인프라가 생기면 이 알림-후-수동전달
 * 단계를 자동 발송으로 교체하면 된다.
 */
export function renderForgotPassword(): string {
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<title>ARKAIN — 비밀번호 재설정</title>
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
    <h1>비밀번호 재설정 요청</h1>
    <label for="companyCode">회사코드</label>
    <input id="companyCode" placeholder="예: A1B2C3" autocomplete="off" />
    <label for="email">이메일</label>
    <input id="email" type="email" placeholder="you@example.com" />
    <button id="submit" type="button">재설정 요청</button>
    <div id="msg"></div>
    <p class="muted">이미 재설정 코드를 받으셨나요? <a href="/account-recovery/reset">코드 입력하기</a></p>
    <p class="muted"><a href="/login">로그인으로 돌아가기</a></p>
  </div>

  <script>
    document.querySelector("#submit").addEventListener("click", async () => {
      const msg = document.querySelector("#msg");
      const companyCode = document.querySelector("#companyCode").value.trim();
      const email = document.querySelector("#email").value.trim();
      if (!companyCode || !email) {
        msg.innerHTML = '<span class="badge err">회사코드와 이메일을 입력해주세요</span>';
        return;
      }
      msg.textContent = "요청 중…";
      try {
        const res = await fetch("/api/auth/forgot-password/request", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ companyCode, email }),
        });
        const data = await res.json();
        if (!res.ok) {
          msg.innerHTML = '<span class="badge err">' + (data.error ?? "요청 실패") + "</span>";
          return;
        }
        msg.innerHTML = '<span class="badge ok">요청이 접수되었습니다. 확인 후 등록하신 연락처로 재설정 코드를 안내드립니다.</span>';
      } catch (err) {
        msg.innerHTML = '<span class="badge err">요청 실패</span> ' + err;
      }
    });
  </script>
</body>
</html>`;
}
