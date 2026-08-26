---
name: skill-gap
description: 이미 만들어진 경력 기술서(career 계층)를 입력으로 지식맵(knowledge-map)과 갭 리포트(gap-report)를 생성할 때 사용한다. 사용자의 자가진단을 받아 커밋이 뒷받침하는 지식과 본인이 느끼는 숙련도를 대조하고, 인용 무결성 검증을 통과한 산출물만 기록한다. "내가 뭘 모르는지 모르겠다", 학습 우선순위 정리, 면접 대비 지식 점검이 필요할 때 쓴다. 퀴즈로 재검증하지는 않는다(P0 범위).
---

# skill-gap — 지식맵·갭 리포트 생성 오케스트레이션

`/devcareer-prep:skill-gap`의 실행 절차다. **이 문서는 오케스트레이션의 절차서이지
생성 프롬프트가 아니다.** 지식맵을 만드는 프롬프트는
`skills/skill-gap/templates/knowledge-mapper.md`, 갭 리포트를 만드는 프롬프트는
`skills/skill-gap/templates/gap-analyzer.md`, 두 계층의 반증을 수행하는 프롬프트는
`skills/skill-gap/templates/gap-fact-checker.md`에 있다.

## 이 스킬이 지켜야 하는 것 — 먼저 읽어라

`career-from-git`과 같은 계약 넷이 그대로 걸린다. 산출물을 직접 쓰지 않고
(`scripts/write-artifact.mjs`가 유일한 경로), 원장 원본을 읽지 않고(투영 결과만),
판정을 자칭하지 않고(`verification`은 반증을 실제로 수행한 뒤에만), `locked`를 적지
않는다. 여기서 반복하지 않는다 — **어겼는지 여부는 이 문서가 아니라 스크립트가
판정한다.**

이 스킬에만 있는 것은 아래 넷이다.

1. **상위 계층이 먼저 있어야 한다.** 지식맵은 career 노드를 참조하고, 갭 리포트는
   지식맵 노드를 참조한다. 그 참조 무결성은 AC-14가 검사하며, **상위 산출물을 함께
   넘기지 않으면 위반이 아니라 `unverifiable`로 분류된다** — 리포트상 위반 0건인데
   사실은 미검증인 상태다. 그래서 8단계는 `--out-dir`로 전 계층을 함께 넘긴다.
2. **근거 등급에 `commit`이 없다.** 지식과 갭은 git에 존재하는 사실이 아니므로
   `inference`(근거 커밋을 나열한다) 또는 `external`(allow-list 안의 URL)만 쓸 수
   있고, 둘 다 아니면 `insufficient`다.
3. **자가진단은 사용자에게서 받는다.** 지어내지 마라. 갭은 「커밋이 뒷받침하는 것」과
   「본인이 안다고 느끼는 것」의 차이이고, 뒤쪽을 기계가 대신 채우면 그 차이는 아무
   것도 뜻하지 않는다.
4. **근거가 낡았는지 먼저 확인한다.** 0단계가 그것이다.

## 모델 티어 — 세션 모델을 그대로 상속시키지 마라

전역 규약이다. 이 스킬이 띄우는 서브에이전트는 **세션 모델을 상속하지 않고** 아래
티어를 명시한다.

| 단계 | 성격 | 티어 |
|---|---|---|
| 판독·검증·렌더 | 기계 실행(스크립트) | 서브에이전트 없음 — 프로세스 호출 |
| KnowledgeMapper | 서술 생성 | **중간 티어** |
| GapAnalyzer | 서술 생성 | **중간 티어** |
| GapFactChecker | 반증 판정 | **상위 티어** |

`career-from-git`과 같은 근거다 — 생성은 다시 만들면 되지만 잘못된 판정은 그대로
산출물에 남는다.

서브에이전트 프롬프트의 **첫 줄에 출력 언어를 한국어로 명시**한다.

## 절차

### 0. 근거가 낡았는지 먼저 확인한다 — 건너뛰지 마라

```sh
node scripts/read-registry.mjs --root <저장 루트> --repo <레포 경로> --layer career
```

레지스트리에서 career 산출물의 경로를 찾아, **그 파일의** `sourceRepoHead`를 현재
HEAD와 대조한다(레지스트리 값이 아니라 파일 값이 정본이다 — AC-16).

종료 코드마다 취할 조치가 다르다. **뭉뚱그리지 마라.**

| 코드 | 뜻 | 조치 |
|---|---|---|
| 0 | 신선 — career 산출물이 현재 HEAD에서 생성됐다 | 1단계로 |
| 2 | 입력 오류(인자·저장 경계·`--repo`) — 판정을 시도하지 않았다 | 인자를 고친다 |
| 3 | **스테일** — 근거가 현재 HEAD보다 오래됐다 | **경고를 보여 주고 계속/중단을 사용자에게 묻는다**(아래) |
| 4 | **판정 불가** — 레지스트리 부재·손상·계층 미등록·산출물 판독 실패 | 재수집을 안내하고 **정상 종료한다** |

**exit 3을 조용히 넘기지 마라.** 스크립트가 두 해시를 모두 보고하므로 그대로 보여
주고 판단을 받는다. 계속하기로 하면 그 사실을 최종 보고에도 적는다 — 사용자가 「낡은
근거 위에서 만든 갭 리포트」임을 알고 있어야 한다.

**exit 4는 실패가 아니라 「모른다」다.** 「최신임을 확인했다」와 구별되므로 0으로
읽지 마라. 이 경우 갭 분석을 시작하지 말고 `career-from-git`을 먼저 돌리라고
안내한다.

### 1. 설정 판독 — 저자를 손으로 다시 조립하지 마라

`career-from-git`의 1-b단계가 기록한 `config.json`이 저장 루트에 있다. 8단계의 인용
검증이 그 파일에서 저자를 읽으므로(**결정 D3**), 여기서 이메일을 손으로 모으지 않는다.
없으면 `career-from-git`을 먼저 돌리라고 안내하고 멈춘다 — 기계가 대신 채우면 사용자가
확정하지 않은 범위 위에 그 뒤의 모든 근거가 선다.

### 2. 투영 — LLM 컨텍스트에 넣을 형태로 좁힌다

```sh
node scripts/project-ledger.mjs --root <저장 루트> --out <저장 루트>/ledger-projection.json
```

**템플릿에게 주는 원장은 이 파일뿐이다.** 원장 원본을 열지 마라 — 범위 밖 저자의
커밋 정보가 LLM 컨텍스트로 흘러드는 것은 되돌릴 수 없다.

career 산출물은 0단계가 알아낸 레지스트리 경로에서 읽는다(손으로 조립하지 마라).

### 3. KnowledgeMapper 디스패치 (중간 티어)

`skills/skill-gap/templates/knowledge-mapper.md`를 프롬프트로 쓴다. 투영 파일과
career 산출물을 입력으로 주고, 출력은 **draft 단계 knowledge-map JSON**이다.

출력에는 `verification`도 `locked`도 **없어야 한다**. 있으면 다음 단계가
`AUTHORSHIP` 위반으로 exit 1을 낸다.

### 4. knowledge-map draft 기록

```sh
node scripts/write-artifact.mjs --layer knowledge-map --draft <draft.json> \
  --root <저장 루트> --stage draft --skill skill-gap
```

종료 코드 분기는 `career-from-git` 4단계의 표와 같다(0/1/2/3/4). **exit 3을
`--force`로 자동 재시도하지 마라** — 사용자가 손으로 고친 내용을 덮어쓰는 결정이고,
기계가 대신할 수 없다.

### 5. 자가진단 수집 — 지어내지 마라

지식맵의 각 주제를 사용자에게 보여 주고 **본인이 느끼는 숙련도를 직접 받는다.**
받은 원문을 요약해 `selfAssessment`에 싣는다(퀴즈로 재검증하지 않는다 — P0 범위이며,
그 한계를 사용자에게도 말한다).

**주제가 많으면 전부 묻지 말고 사용자가 고르게 하라.** 다만 묻지 않은 주제를
「모른다」로도 「안다」로도 채우지 마라 — 갭 리포트에서 빼는 것이 정직하다.

### 6. GapAnalyzer 디스패치 (중간 티어) → gap-report draft 기록

`skills/skill-gap/templates/gap-analyzer.md`를 프롬프트로 쓴다. 지식맵 산출물과
5단계의 자가진단을 입력으로 준다.

```sh
node scripts/write-artifact.mjs --layer gap-report --draft <draft.json> \
  --root <저장 루트> --stage draft --skill skill-gap
```

### 7. GapFactChecker 디스패치 (상위 티어) → fact-checked 기록

`skills/skill-gap/templates/gap-fact-checker.md`를 프롬프트로 쓴다. **두 계층을 모두
넘긴다** — 판정 축이 같으므로 템플릿 하나가 둘을 본다.

```sh
node scripts/write-artifact.mjs --layer knowledge-map --draft <판정 실린 JSON> \
  --root <저장 루트> --stage fact-checked --skill skill-gap
node scripts/write-artifact.mjs --layer gap-report --draft <판정 실린 JSON> \
  --root <저장 루트> --stage fact-checked --skill skill-gap
```

**이 단계를 건너뛰면 산출물이 영구히 미검증으로 남는다.** 병합이 신규 노드에 채우는
값은 `not-attempted`이고, 그 상태로는 렌더가 전 노드에 「근거 부족 - 미검증」 배지를
붙인다. 배지가 정직한 것은 맞지만, 그것은 반증을 돌리지 않았다는 뜻이지 반증에
실패했다는 뜻이 아니다.

### 8. 인용 무결성 검증 — 이 단계를 건너뛰지 마라

```sh
node scripts/verify-evidence.mjs --repo <레포 경로> \
  --config <저장 루트>/config.json \
  --evidence <원장 경로> --out-dir <저장 루트>
```

**`--out-dir`을 쓴다.** 계층을 하나씩 넘기면 상위 계층이 빠진 호출이 생기고, 그러면
`checkLayerRefs`가 그 노드를 **위반이 아니라 `unverifiable`로 분류한다** — AC-14의
「미해결 참조 0건」이 참이 아니라 **미검증**인데도 리포트상 위반 0건으로 보인다.

**`--config`를 쓴다(결정 D3).** 1단계가 읽은 그 파일에서 저자를 읽으므로 이메일을
손으로 다시 조립하지 않는다. `--config`도 `--identity`도 없으면 이 스크립트는 검증
축에 도달하기 **전에** `selectedIdentities가 비어 있습니다`로 exit 2한다 — 즉 반증이
한 번도 실행되지 않은 채 「검증했다」고 말하게 된다.

**`--sources`를 붙이지 마라 — 기본값이 더 안전하다.** `basis: "external"` 노드의
`externalUrl`을 allow-list와 대조하는 축(구현 8단계 (a))은 **인자 없이도 돈다**:
스크립트가 자기 위치 기준으로 `references/sources.json`을 찾는다. 반대로 그 경로를
상대경로로 넘기면 **사용자 레포에서 실행될 때 풀리지 않아** `EXTERNAL_ALLOWLIST_UNREADABLE`
FAIL이 난다(실측). 이 계층들은 `external`을 실제로 쓰는 유일한 계층이라 그 FAIL을
가장 먼저 만나는 것도 여기다. **다른 allow-list를 쓰려는 것이 아니면 생략하라.**

exit 1(FAIL)이나 exit 2면 **사용자에게 보고하고 멈춘다.** exit 2는
`[INPUT_ERROR]`(인자·파일 문제)와 `[INCONCLUSIVE]`(검증을 완결하지 못함) **둘 다**에
쓰이므로 stderr 접두사로 구별하라 — 「증거가 부족해 결론을 못 냈다」와 「내가 인자를
잘못 줬다」는 사용자에게 전혀 다른 이야기다.

### 9. 마스킹 우회 검사

```sh
node scripts/validate-plugin.mjs --secret-scan <저장 루트>/knowledge-map.json
node scripts/validate-plugin.mjs --secret-scan <저장 루트>/gap-report.json
```

### 10. 마크다운 렌더

```sh
node scripts/render-markdown.mjs --layer knowledge-map \
  --in <저장 루트>/knowledge-map.json --out <저장 루트>/knowledge-map.md
node scripts/render-markdown.mjs --layer gap-report \
  --in <저장 루트>/gap-report.json --out <저장 루트>/gap-report.md
```

마크다운은 JSON의 **뷰**다. 렌더러가 만들지 않은 문장을 여기서 덧붙이지 마라.

## 사용자에게 보고할 때

- **0단계가 exit 3이었으면 그 사실을 반드시 함께 말한다.** 낡은 근거 위에서 만든
  갭 리포트라는 것은 사용자가 결과를 읽는 방식을 바꾼다.
- **커버리지 3수치와 절단 여부를 함께 말한다.** 상위 계층에서 물려받은 값이며,
  「커밋 300건을 분석했다」만 말하고 「전체 1200건 중」을 빼면 그것은 과장이다.
- **강등된 항목을 숨기지 마라.** 반증에서 무너진 항목이 몇 건인지 같이 보고한다.
- **자가진단을 받지 않은 주제는 「갭 없음」이 아니다.** 묻지 않았다고 말하라.
- **퀴즈 재검증이 없다는 한계를 말한다.** 자가진단은 사용자의 자기 보고이고,
  이 도구는 그것을 검증하지 않는다(P0 범위).
