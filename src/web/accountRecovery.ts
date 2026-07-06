import { DESIGN_TOKENS_CSS } from "./layout.js";

/**
 * ARK-86: 로그인 화면의 "회사코드/비밀번호를 잊으셨나요?" 링크가 도착하는 허브.
 * 회사코드 찾기(findCompanyCode.ts)와 비밀번호 재설정(forgotPassword.ts)은 서로
 * 다른 위험도의 별개 흐름이라 각자 전용 화면을 갖고, 이 페이지는 그 두 곳으로
 * 안내만 한다.
 */
export function renderAccountRecovery(): string {
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<title>ARKAIN — 계정 찾기</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
${DESIGN_TOKENS_CSS}
  body { display: flex; align-items: center; justify-content: center; min-height: 100vh; }
  .auth-card { width: 100%; max-width: 420px; background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 2rem 2rem 1.75rem; }
  .brand { font-weight: 700; font-size: 1.2rem; color: var(--brand); margin-bottom: 0.25rem; }
  h1 { font-size: 1.05rem; color: var(--ink-muted); font-weight: 500; margin-bottom: 1.25rem; }
  .recovery-option { display: block; border: 1px solid var(--border); border-radius: 10px; padding: 1rem 1.1rem; margin-top: 0.75rem; text-decoration: none; color: inherit; }
  .recovery-option:hover { border-color: var(--brand); }
  .recovery-option .title { font-weight: 600; }
  .recovery-option .desc { font-size: 0.85rem; color: var(--ink-muted); margin-top: 0.2rem; }
  .muted { margin-top: 1.25rem; text-align: center; }
</style>
</head>
<body>
  <div class="auth-card">
    <div class="brand">ARKAIN</div>
    <h1>무엇을 도와드릴까요?</h1>

    <a class="recovery-option" href="/account-recovery/company-code">
      <div class="title">회사코드를 잊으셨나요?</div>
      <div class="desc">가입하신 이메일로 회사코드를 확인할 수 있습니다.</div>
    </a>
    <a class="recovery-option" href="/account-recovery/password">
      <div class="title">비밀번호를 잊으셨나요?</div>
      <div class="desc">회사코드와 이메일로 비밀번호 재설정을 요청할 수 있습니다.</div>
    </a>

    <p class="muted"><a href="/login">로그인으로 돌아가기</a></p>
  </div>
</body>
</html>`;
}
