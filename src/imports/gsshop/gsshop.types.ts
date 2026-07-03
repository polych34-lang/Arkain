import { z } from "zod";

/**
 * GS샵 파트너스 포털 "주문리스트" 엑셀 임포트 — 한 줄 = 한 품목(line item), 같은
 * 주문번호를 가진 여러 줄이 하나의 주문을 이룬다(네이버 productOrder 패턴과 동일
 * 발상, `naver.mapper.ts` 참고).
 *
 * **가정 스키마, 실 샘플 미확보(ARK-15 §6 한계 그대로 계승).** 아래 헤더 별칭은
 * GS샵 파트너스 공개 정보와 업계 통상 "주문리스트 다운로드" 엑셀 관행을 근거로 한
 * 최선의 추정이다. 실제 내려받은 파일로 검증되기 전까지는 "현재까지의 최선
 * 추정"으로 취급할 것 — docs/gsshop-excel-import.md 참고. 헤더가 하나도 안 맞으면
 * (아래 REQUIRED_FIELDS 미충족) 조용히 잘못된 숫자를 만드는 대신 즉시 실패한다.
 */

/** 쉼표 천단위 구분("12,000")까지 흔한 엑셀 숫자 표기이므로 문자열을 직접 받아
 * 쉼표를 제거하고 숫자로 변환한다. 빈 셀/변환 불가는 여기서 바로 실패시켜, 숫자
 * 필드가 조용히 0으로 채워지는(=금액이 틀리는) 일을 막는다. */
function numericString(label: string) {
  return z
    .string()
    .trim()
    .min(1, `${label} 값이 비어 있습니다`)
    .transform((s) => Number(s.replace(/,/g, "")))
    .refine((n) => Number.isFinite(n), {
      message: `${label}을(를) 숫자로 변환할 수 없습니다`,
    });
}

/** 정규화된 한 줄(raw 헤더 이름 -> 캐노니컬 필드로 이미 매핑된 상태)의 zod 스키마.
 * 셀 값은 항상 문자열(또는 null)로 넘어온다 — 파서(gsshopExcelParser.ts)가
 * exceljs 셀 값을 미리 문자열화한다. */
export const GsShopRow = z.object({
  orderNo: z.string().trim().min(1, "주문번호 값이 비어 있습니다"),
  orderedAt: z.string().trim().min(1, "주문일시 값이 비어 있습니다"),
  status: z.string().trim().min(1, "주문상태 값이 비어 있습니다"),
  buyerName: z.string().trim().min(1).nullable().default(null),
  productCode: z.string().trim().min(1).nullable().default(null),
  productName: z.string().trim().min(1, "상품명 값이 비어 있습니다"),
  quantity: numericString("수량").refine((n) => Number.isInteger(n) && n > 0, {
    message: "수량은 1 이상의 정수여야 합니다",
  }),
  amountKrw: numericString("금액").refine((n) => n >= 0, {
    message: "금액은 0 이상이어야 합니다",
  }),
});
export type GsShopRowT = z.infer<typeof GsShopRow>;

/** 캐노니컬 필드 -> 허용되는 헤더 텍스트(공백 무시, 대소문자 무시) 별칭 목록.
 * 필수 필드(REQUIRED_FIELDS)가 하나라도 매칭되는 헤더가 없으면
 * `GsShopFormatError`를 던진다 — 엑셀 포맷이 통째로 다른 파일(잘못된 파일 업로드,
 * 향후 포털 개편)을 조용히 잘못 파싱하지 않기 위함. */
export const HEADER_ALIASES: Record<keyof GsShopRowT, string[]> = {
  orderNo: ["주문번호"],
  orderedAt: ["주문일시", "주문일자", "결제일시"],
  status: ["주문상태", "처리상태"],
  buyerName: ["수취인명", "수취인", "주문자명", "고객명"],
  productCode: ["상품코드", "상품번호", "옵션코드"],
  productName: ["상품명"],
  quantity: ["수량", "주문수량"],
  amountKrw: ["상품금액", "결제금액", "합계금액", "정산금액"],
};

/** 이 필드들의 헤더가 하나도 안 잡히면 "GS샵 주문리스트 엑셀이 맞는지" 자체가
 * 의심스러운 상태 — 파싱을 진행하지 않고 즉시 실패한다. buyerName/productCode는
 * 선택 필드라 여기서 빠진다(누락돼도 주문 자체는 정상 처리 가능). */
export const REQUIRED_FIELDS: (keyof GsShopRowT)[] = [
  "orderNo",
  "orderedAt",
  "status",
  "productName",
  "quantity",
  "amountKrw",
];

export class GsShopFormatError extends Error {
  constructor(readonly missingFields: (keyof GsShopRowT)[]) {
    const labels = missingFields.map((f) => HEADER_ALIASES[f][0]).join(", ");
    super(
      `GS샵 주문리스트 엑셀 형식이 아닌 것 같습니다 — 다음 필수 컬럼을 찾지 못했습니다: ${labels}`,
    );
    this.name = "GsShopFormatError";
  }
}

/** 한 행(row)의 파싱/검증 실패 — 배치 전체를 막지 않고 이 행만 건너뛴다
 * (docs/gsshop-excel-import.md "부분 성공" 정책). */
export interface GsShopRowError {
  /** 1-based, 엑셀 헤더 행을 포함한 실제 행 번호(엑셀에서 셀러가 찾기 쉽도록). */
  row: number;
  message: string;
}
