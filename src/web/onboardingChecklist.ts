/**
 * ARK-75: 가입 완료 → 첫 로그인 사이 셀러가 다음에 뭘 해야 할지 안내가 없는 상태를
 * 메꾸는 체크리스트 카드. 상품등록 대시보드(가입 직후 landing, signup.ts의
 * "시작하기" 버튼이 여기로 보낸다) 상단에 얹는다. 이미 있는 /api/connections,
 * /api/products, /api/orders 응답만으로 완료 여부를 판단 — 새 백엔드 엔드포인트 없이
 * 클라이언트에서 조합한다. 3단계 모두 완료되면 카드 자체를 숨긴다.
 */
export function renderOnboardingChecklist(): string {
  return `
    <style>
      #onboardingChecklist ul { list-style: none; padding: 0; margin: 0.75rem 0 0; }
      #onboardingChecklist li {
        display: flex; align-items: center; gap: 0.6rem;
        padding: 0.5rem 0; font-size: 0.92rem;
      }
      #onboardingChecklist .check-mark {
        display: inline-flex; align-items: center; justify-content: center;
        width: 1.3rem; height: 1.3rem; border-radius: 50%;
        border: 1.5px solid var(--border); color: transparent; font-size: 0.8rem; flex-shrink: 0;
      }
      #onboardingChecklist li.done .check-mark {
        border-color: var(--success-ink); background: var(--success-bg); color: var(--success-ink);
      }
      #onboardingChecklist li.done a { color: var(--ink-muted); text-decoration: line-through; }
    </style>
    <div class="card" id="onboardingChecklist" style="margin-bottom: 1.25rem;">
      <div style="display:flex;align-items:center;justify-content:space-between;">
        <strong>시작 체크리스트</strong>
        <span class="muted" id="checklistProgress"></span>
      </div>
      <ul>
        <li data-key="connect"><span class="check-mark">✓</span><a href="/onboarding/naver">마켓 연동</a></li>
        <li data-key="product"><span class="check-mark">✓</span><a href="/products">상품 등록</a></li>
        <li data-key="order"><span class="check-mark">✓</span><a href="/orders">주문 확인</a></li>
      </ul>
    </div>
    <script>
      (function () {
        const card = document.getElementById("onboardingChecklist");
        const progress = document.getElementById("checklistProgress");

        async function loadChecklist() {
          const me = await (await fetch("/api/auth/me")).json();
          if (!me.authenticated) return;
          const tenantId = me.sellerId;
          const [connRes, prodRes, orderRes] = await Promise.all([
            fetch("/api/connections?tenantId=" + encodeURIComponent(tenantId)),
            fetch("/api/products"),
            fetch("/api/orders?limit=1"),
          ]);
          const [connData, prodData, orderData] = await Promise.all([
            connRes.json(),
            prodRes.json(),
            orderRes.json(),
          ]);
          const state = {
            connect: !!connData.configured && connData.connections.length > 0,
            product: !!prodData.configured && prodData.products.length > 0,
            order: !!orderData.configured && orderData.orders.length > 0,
          };
          let doneCount = 0;
          for (const key of Object.keys(state)) {
            const li = card.querySelector('[data-key="' + key + '"]');
            li.classList.toggle("done", state[key]);
            if (state[key]) doneCount++;
          }
          progress.textContent = doneCount + " / 3 완료";
          card.hidden = doneCount === 3;
        }

        loadChecklist();
      })();
    </script>
  `;
}
