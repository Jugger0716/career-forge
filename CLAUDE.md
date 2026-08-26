# career-forge — Claude Code 작업 지침

개발자의 Git 히스토리를 결정적으로 수집해 경력 기술서·지식맵·갭 리포트를 만드는
Claude Code 플러그인(`devcareer-prep`). **핵심 가치는 할루시네이션 방지이고, 그 방어를
LLM 판단이 아니라 결정적 스크립트가 집행한다.**

## 정본 문서 — 이 순서로 읽어라

| 문서 | 무엇이 정본인가 |
|---|---|
| `docs/devcareer-prep-plugin/slice_b_spec_review.md` | **현재 진행 상태의 정본.** 뒤쪽 세 절(「정정 기록」·「작업 순서」·「콜드 리뷰 라운드 1」)이 무엇이 끝났고 무엇이 남았는지를 담는다. 여기와 `git log`가 어긋나면 코드가 이긴다. |
| `docs/devcareer-prep-plugin/spec.md` | 실행 스펙 정본. **통독하지 말고 필요한 구현 단계만 잘라 읽어라.** |
| `docs/devcareer-prep-plugin/slice_plan.md` | 3슬라이스 분할과 **슬라이스 A 파일 수정 예외 표**. |
| `docs/devcareer-prep-plugin/conventions.md` | 규약. §9가 문서 위치·추적 정책을 정한다. |
| `docs/devcareer-prep-plugin/plan_critic_findings.md`, `docs/devcareer-prep-plugin/cold_review.md` | 심사·리뷰 기록(백로그). 체크박스 열을 일괄로 뒤집지 마라 — 정당한 `[ ]`가 섞여 있다. |

## 절대 규칙

1. **산출물과 설정은 전용 CLI로만 쓴다.** `scripts/write-artifact.mjs`(산출물)와
   `scripts/write-config.mjs`(설정)가 디스크에 닿는 유일한 경로다. 파일을 직접 쓰면
   쓰기 직전 자기 스키마 검증·재생성 병합·기입 주체 검사가 **전부 건너뛰어진다.**

2. **원장 원본을 LLM 컨텍스트에 넣지 마라.** `scripts/project-ledger.mjs`가 만든
   투영 결과만 프롬프트에 들어간다 — 원본에는 범위 밖 커밋의 정보가 남아 있다.

3. **관측되지 않는 제약은 없는 것이다.** 새 제약에는 **양방향** 단언(금지 방향과
   허용 방향)을 붙이고, 격리 사본에서 **변이를 실제로 넣어** 그 단언이 자기 몫만
   FAIL시키는지 확인하라. 격리는 `git clone --no-hardlinks` 후 시험 대상 파일만
   덮어쓰기다 — `cp -r`은 격리 사본이 아니다.

4. **단언 수가 바뀌면 `EXPECTED_ASSERTIONS_BEFORE_GUARDS`를 함께 고친다.**
   `tests/run-smoke.mjs`의 총량 가드가 정확 일치로 강제하며, 그 마찰은 비용이 아니라
   의도다. **하한(`>=`)으로 완화하지 마라.**

5. **슬라이스 A 파일을 고치지 마라.** 허용되는 것은 `slice_plan.md`의 예외 표에 적힌
   건뿐이고, 예외는 **그 항목이 회차 작업을 실제로 막을 때만** 추가한다. 막지 않는데
   「겸사겸사」 고치는 것은 이연 결정을 무효로 만든다.

6. **판독·검증 실패를 빈 값이나 default로 강등하지 마라.** 부재는 FAIL이다.
   빈 문자열·빈 배열·`null`로 바꾸면 그 자리가 조용히 초록이 된다 — 이 레포가 반복해서
   실측한 사고 형태다. 스키마에 default가 있어도 사용자 결정을 기계가 대신 채우지 않는다.

## 게이트

```sh
npm run lint     # exit 0이어야 한다
npm test         # 기본 → --negative → --golden 순서
```

네 게이트가 전부 0 FAIL이어야 완료다. **`--golden`은 10분을 넘기므로 백그라운드로 돌려라** —
전경에서 타임아웃에 죽으면 진행 상황을 잃는다. 커밋 뒤에는 새 클론에서 한 번 더 확인한다
(추적되지 않는 파일 때문에 워킹 트리 녹색이 클론 녹색을 뜻하지 않는다).

## 이 파일이 다루지 않는 것

출력 언어, 서브에이전트 모델 라우팅, 세션 연속성(`/handoff`)은 **사용자 전역
`CLAUDE.md`**의 소관이다. 여기서 반복하지 않는다 — 두 곳에 적으면 갈린다.

리뷰 리포트·핸드오프 같은 회차 산출물이 사는 도구 작업 디렉터리는 **gitignore돼
추적되지 않는다**. 위치와 정책은 `docs/devcareer-prep-plugin/conventions.md` §9에 있으며,
**추적되는 파일이 그 아래 경로를 참조하면 새 클론에서만 깨진다** — 스모크의 DH-1 가드가
막는다.
