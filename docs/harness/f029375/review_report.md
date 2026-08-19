# Code Review Report

| Field | Value |
|-------|-------|
| Target | f029375 (범위 한정: 신규 스크립트 3개 + `tests/run-smoke.mjs` 오라클 3섹션) |
| Mode | thorough (workflow · frontier) |
| Files | 4 files |
| Lines | +1390 / -0 |
| Date | 2026-08-19 |
| HEAD | a22832965f18549e93c8ca9c70478e9de265ba89 |

## Assessment: REQUEST_CHANGES

## Summary

전문 리뷰어 3명(보안·정확성 / 아키텍처·설계 / DX·유지보수) 병렬 → 적대적 교차검증 3건 → 종합으로
20건이 나왔다(critical 0). **오케스트레이터가 major 2건과 가장 위험한 minor 1건을 실제로 실행해
재현을 확인했고, 그 결과 1건의 심각도를 올렸다.**

- **M-1(재현됨)**: prev에 `attempts >= 1`인 비잠금 노드가 있으면 `--stage draft`로 그 노드를
  재작성할 방법이 **하나도 없다**. 네 갈래 탈출구를 모두 실행해 전부 exit 1임을 확인했다
  (RESET / 스키마 const / SET_BY_TEMPLATE / CHURN). CareerWriter → FactChecker 순환의 2회차가
  쓰기 경계에서 원천 봉쇄된다.
- **M-2(재현됨)**: exit 4(산출물은 기록됐으나 레지스트리 갱신 실패)가 깨진 `state.json` 하나로
  결정적으로 재현되는데, 스위트 전체에 `status === 4` 단언이 **0건**이다(grep 확인). 파일 헤더가
  스스로 "'쓰지 않았다' 불변식을 깨는 유일한 코드"라고 못 박은 분기만 관측 밖이다.
- **M-3(재현됨, 승격)**: `nodes` 필드가 없는 draft를 넣자 **exit 0으로 성공하면서 비잠금 노드가
  삭제**됐다(v1 `[car:001, car:002]` → 결과 `[car:002]`, `.bak` 없음). 리뷰어는 minor로 냈으나
  성공 종료 코드를 달고 나가는 조용한 데이터 유실이므로 major로 올렸다 — M-1은 시끄럽게 막고
  데이터를 잃지 않는데 이쪽은 그 반대다.

작성자가 리뷰 전에 이미 자체 발견해 기록한 2건(`--stage` 자기 선언 / 나쁜 재생성의 조용한 노드
삭제)은 중복 보고 대상에서 제외했다. **`--fix`는 쓰지 않았다 — 워킹 트리는 이 리뷰로 변경되지
않았다.**

## Findings

### Critical

| — | — | — | 없음 | — |

### Major

| # | File:Line | Category | Description | Suggestion |
|---|-----------|----------|-------------|------------|
| 1 | `scripts/lib/artifact-contract.mjs:147` | Correctness | nodes가 배열이 아닌 draft가 fail-open으로 통과해 잠기지 않은 prev 노드를 조용히 전멸시킴 **[오케스트레이터가 minor→major로 승격]**<br><br>checkAuthorshipContract L147과 mergeArtifact L231이 모두 `Array.isArray(instance?.nodes) ? instance.nodes : []`로 nodes 비배열(부재·null·문자열 — LLM 출력 절단에서 실제로 나오는 형태)을 빈 배열로 강등한다. 그 결과 (1) 기입 주체 검사가 위반 0건으로 통과하고, (2) 병합이 mergedNodes를 locked 생존자만으로 조립하며(L316-318), (3) 반환값이 `{ ...draft, nodes: mergedNodes }`(L321)라 merged는 항상 nodes 배열을 갖게 되어 draft가 기형이었다는 신호가 스키마 검증 앞에서 세탁된다. career.schema.json의 minItems:1 백스톱은 prev에 locked 노드가 0건일 때만 작동하므로, prev에 locked 노드가 1건이라도 있으면 기형 draft가 exit 0(성공)으로 기록되면서 잠기지 않은 모든 prev 노드가 소리 없이 삭제된다. 이 모듈이 VERIFICATION_MISSING·PREV_ARTIFACT_HASH_MISSING에서 표방한 fail-closed 원칙과 정면으로 어긋나는 통로다(합성 과정에서 코드로 직접 재확인함). | checkAuthorshipContract 진입부(또는 write-artifact.mjs main()의 draft 파싱 직후)에서 `Array.isArray(instance?.nodes)`가 거짓이면 NODES_NOT_ARRAY류 위반 또는 [INPUT_ERROR] exit 2로 즉시 거부하고, prev에 locked 노드가 있는 상태에서 nodes 없는 draft를 넣는 WA 테스트를 추가하십시오. |
| 2 | `scripts/lib/artifact-contract.mjs:278`-294 | Correctness | draft 단계에서 attempts>=1 노드는 재작성 자체가 불가능 — 계약 3중 자기모순<br><br>세 계약이 서로를 배제한다. (1) checkAuthorshipContract L180은 draft 단계에서 verification.status !== "not-attempted"를 위반으로 잡고, (2) career.schema.json L203-204는 status가 not-attempted이면 attempts를 const 0으로 강제하며, (3) mergeArtifact L281-284는 draftAttempts < prevAttempts를 VERIFICATION_ATTEMPTS_RESET으로 거부한다. 따라서 prev에 attempts>=1인 비잠금 노드가 있을 때 --stage draft로 같은 노드를 재작성하면: attempts 0으로 쓰면 RESET 위반(exit 1), attempts를 이어받으면 병합 결과에 대한 스키마 검증이 const 0 위반(exit 1, 검증 대상은 merged 객체임 — write-artifact.mjs L282), 새 id로 도망가면 text가 같으므로 NODE_ID_CHURN(exit 1). 탈출구는 locked이거나(규칙 1이 L272에서 규칙 3보다 먼저 continue) text를 바꾸는 것뿐이다. 구현 7단계 (b)가 핵심 시나리오로 든 '재생성-재검증 순환'이 draft 쓰기 경로에서 원천 봉쇄된다. 유일한 완화책인 'fact-checked 단계로만 재생성 쓰기를 한다'는 관례는 계약 어디에도 강제·문서화되어 있지 않다. 교차검증 2건 모두 코드로 재구성해 Confirmed 판정. | mergeArtifact에 stage 인자를 넘겨 draft 단계에서는 규칙 3(attempts 감소 거부)을 적용하지 않게 하거나, draft가 verification 필드를 아예 생략/무시하도록 authorship 계약을 바꿔 스키마의 not-attempted→attempts:const 0 제약과 재시도 이어받기 요구가 동시에 성립하게 하십시오. 어느 쪽이든 SC#6이 지적한 draft 성공 쓰기 오라클을 함께 추가해 결정을 고정해야 합니다. |
| 3 | `scripts/write-artifact.mjs:297`-302 | Testing | exit 4(산출물은 기록됨 + 레지스트리 갱신 실패) 분기가 어떤 오라클로도 관측되지 않음<br><br>파일 헤더(L37-41)는 exit 4를 "'쓰지 않았다' 불변식을 깨는 유일한 코드 — 같은 값에 섞으면 재시도가 덮어쓰기가 된다"고 스스로 못 박았는데, tests/run-smoke.mjs의 WA-1~WA-14는 status 0/1/2/3만 실행 검증하고 exit 4는 2385행 주석에서 언급만 될 뿐 어떤 테스트도 유발하지 않는다(전체에서 `status === 4` 단언 0건). 함께 미검증인 것이 updateRegistry의 손상 레지스트리 거부 로직(L166-170, '손상된 레지스트리를 덮어쓰면 다른 계층의 항목이 사라진다')이라, 이 거부가 회귀해 손상 state.json을 새 골격으로 조용히 덮어써도 현재 스위트는 전부 초록이다. exit 4는 결정적으로 재현 가능하다 — inspectPreviousArtifact는 career.json만 읽으므로 저장 루트에 깨진 state.json을 심어두면 산출물 쓰기까지 진행된 뒤 readState가 found+error를 돌려 L166 분기로 떨어진다. 종료 코드 계약의 전 분기 오라클 검증이 이 diff의 방법론 자체인데 가장 위험한 부분 실패 분기만 관측 밖이다. 교차검증 2건 모두 Confirmed. | 저장 루트에 비-JSON state.json(예: "{broken")을 심어둔 뒤 정상 draft를 쓰는 WA 테스트를 추가해 (1) exit 4, (2) stderr의 [REGISTRY] 접두, (3) career.json은 정상 기록됨, (4) state.json은 원문 그대로 덮어써지지 않음을 함께 단언하십시오. |

### Minor

| # | File:Line | Category | Description | Suggestion |
|---|-----------|----------|-------------|------------|
| 1 | `scripts/lib/artifact-contract.mjs:83`-106 | Maintainability | evidence contentHash 알고리즘이 content-hash.mjs와 이중 구현됨(수정 방식은 논쟁 중)<br><br>contentHashFields(L83)/computeArtifactContentHash(L94)는 content-hash.mjs의 computeEvidenceContentHash와 정확히 같은 절차(고정 필드 목록 [schemaVersion, sourceRepoHead, coverage, truncated, commits] → 새 객체 재조립 → JSON.stringify → SHA-256 hex)를 독립적으로 재구현한다. 두 함수는 서로 호출하지 않고 동기화는 AC-3 단언 하나에 의존하며, computeArtifactContentHash("evidence", …)의 프로덕션 호출자는 0곳이다(호출은 tests/run-smoke.mjs 한 곳뿐 — 3중 grep 확인). content-hash.mjs 헤더는 '정본 계산을 이 파일 하나로 모은다'고 선언했고 artifact-contract.mjs 헤더도 '여기서 재구현하면 정본이 둘로 갈린다'고 경고하므로, 현 구조는 두 헤더의 선언과 자기모순이다. 심각도는 minor로 확정(원 major 보고는 교차검증에서 하향): AC-3이 스모크에서 항상 돌아 드리프트가 즉시 FAIL로 잡히고 영향 범위가 테스트 경계 안이다. 다만 수정 방식에는 이견이 있다 — 단순 위임(evidence 분기를 computeEvidenceContentHash 호출로 교체)은 AC-3을 항진명제로 만들어 L1+ 해시 알고리즘의 유일한 외부 닻을 없앤다는 반론이 있었고, 이 반론은 타당하다. | evidence 분기를 그냥 위임하지 말고, 두 파일이 공통의 하위 레벨 헬퍼 `canonicalHash(fields, instance)` 하나를 함께 쓰되 필드 목록은 각자 선언하도록 바꾸십시오 — 절차의 정본은 하나가 되고 AC-3은 '필드 목록 드리프트'를 잡는 유의미한 닻으로 남습니다. evidence 지원이 정말 불필요하다면 시그니처에서 'evidence'를 빼고 AC-3도 함께 정리하십시오. |
| 2 | `scripts/lib/artifact-contract.mjs:272`-274 | Design | locked 노드를 참조 그대로 재사용해 merged와 prev가 같은 객체를 공유함<br><br>locked===true인 prev 노드를 병합 결과에 넣는 L274 `mergedNodes.push(prevNode)`와 draft에 없던 locked 생존자를 붙이는 L318 `mergedNodes.push(node)`가 얕은 복사조차 없이 원본 참조를 넣는다. mergeArtifact는 '순수 함수'를 표방하는데(L196 주석), export된 이 함수의 다른 호출자가 merged.nodes 원소를 변형하면 그 변경이 prev의 인메모리 표현으로 번진다. 교차검증에서 두 가지 단서가 추가됐다: (a) 현재 유일한 호출자 write-artifact.mjs는 merged의 최상위 필드만 설정하므로 지금 당장 관측되는 오동작은 없고, (b) 제안된 얕은 복사만으로는 격리가 불완전하다 — L297/L312가 push하는 `{ ...node, origin: ... }`도 중첩 verification·evidence 객체를 draft와 공유하므로 일관 격리에는 깊은 복사가 필요하고, 그 비용은 store.mjs projectLedgerForSkills가 같은 이유로 명시적으로 거절한 설계다. | 두 push 지점을 `{ ...prevNode }` / `{ ...node }`로 바꿔 최소한 1단계 참조 공유를 끊고, 함수 주석에 '노드 객체는 얕은 사본이며 중첩 객체는 입력과 공유한다'는 불변식을 명시해 호출자의 기대를 고정하십시오. |
| 3 | `scripts/project-ledger.mjs:79`-118 | Testing | --root·--out 두 사용법이 테스트되지 않음<br><br>사용법 주석(L27-29)이 '--in <evidence.json>'과 '--root <저장 루트>'를 동등한 두 사용법으로 문서화하고 --out 파일 기록도 지원한다고 밝히지만, tests/run-smoke.mjs의 LP-4·LP-5(2308-2327행)는 --in 경로만 spawnSync로 실행한다. --root 모드는 `path.join(opts.root, EVIDENCE_FILE_NAME)`(L94)이라는 고유 결합 로직을 가지며, 이 상수는 생산자 collect-git-facts.mjs의 리터럴과 갈라져 있어(별건 finding 참조) 드리프트가 생겨도 잡을 오라클이 전혀 없다. 교차검증 2건 모두 Confirmed. | 임시 디렉터리에 evidence.json을 둔 뒤 --root로 호출하는 테스트와, --out으로 지정한 경로에 실제 파일이 쓰이는지 확인하는 테스트를 LP 스위트에 추가하십시오. |
| 4 | `scripts/project-ledger.mjs:113`-118 | Maintainability | --out 쓰기만 오류 처리 관례에서 벗어나 계약 밖 종료 코드로 죽음<br><br>이 파일의 다른 모든 I/O(원장 읽기 L97-101, JSON 파싱 L103-108)는 try/catch로 감싸 failInput()을 통해 [INPUT_ERROR] + exit 2로 일관되게 실패하는데, L114의 `fs.writeFileSync(opts.outPath, serialized, "utf8")`만 감싸지 않은 채 노출돼 있다. 존재하지 않는 디렉터리를 --out으로 주면 원시 Node 스택 트레이스와 함께 exit 1로 죽는데, 이는 파일 헤더가 정의한 종료 코드 계약(0/2)에 아예 없는 값이라 원 지적보다 한 겹 더 문제다(교차검증에서 보강). 교차검증 2건 모두 Confirmed. | fs.writeFileSync를 try/catch로 감싸 실패 시 failInput()으로 [INPUT_ERROR] + exit 2에 합류시키거나, 디렉터리를 먼저 만들어 주는 scripts/lib/store.mjs의 writeJsonAtomic류 헬퍼로 대체하십시오. |
| 5 | `scripts/write-artifact.mjs:63`-69 | Maintainability | EMPTY_REGISTRY_ARTIFACTS가 계층 키 집합의 세 번째 손 복제본인데 드리프트 가드가 없음<br><br>계층 키 집합이 이제 세 곳에 독립적으로 존재한다: ARTIFACT_LAYERS의 stateKey(AC-2가 가드), state.schema.json의 artifacts required(additionalProperties:false), 그리고 EMPTY_REGISTRY_ARTIFACTS(L63-69, 참조는 자기 파일 L176뿐). 마지막 것만 어떤 드리프트 가드에도 걸리지 않는다(AC-1~27, LP-1~6, WA-1~14 어디에도 대조 단언 없음 — grep 확인). 새 계층을 ARTIFACT_LAYERS와 스키마 required에 추가하면서 이 상수를 잊으면, state.json이 없는 새 루트의 첫 쓰기에서 base={}라 스프레드 결과에 새 키가 빠지고 updateRegistry의 validateInstance가 required 위반으로 실패한다 — 그 결과가 하필 가장 위험하고 테스트도 없는 exit 4(산출물은 기록됐으나 레지스트리 미갱신)다. 심각도는 교차검증 2건이 major→minor로 조정: 발현 조건이 '새 계층 추가'라는 미래 사건이고, 발현 시 누락 키 이름을 찍는 스키마 오류와 함께 시끄럽게 실패한다. | EMPTY_REGISTRY_ARTIFACTS를 `Object.fromEntries(["evidence", ...Object.values(ARTIFACT_LAYERS).map(l => l.stateKey)].map(k => [k, null]))`처럼 ARTIFACT_LAYERS(또는 state.schema.json의 required)에서 파생시키거나, 최소한 AC-1/AC-2와 같은 형태로 키 집합 일치를 단언하는 드리프트 가드를 추가하십시오. |
| 6 | `scripts/write-artifact.mjs:72` | Maintainability | STATE_SCHEMA_VERSION 하드코딩이 스키마 default와 드리프트 가드 없이 중복<br><br>`const STATE_SCHEMA_VERSION = "0.1.0"`(L72)은 state.schema.json의 properties.schemaVersion.default를 손으로 옮겨 적은 것이고, 주석 스스로 '(state.schema.json의 default와 같은 값)'이라 밝힌다. 같은 diff가 ARTIFACT_LAYERS의 stateKey 집합에는 드리프트 가드(AC-2)를 직접 만들어 두었으면서 이 값에는 같은 종류의 가드를 두지 않은 비대칭이다. 스키마 default가 0.2.0으로 바뀌어도 이 상수를 잊으면 최초 state.json 생성 시 조용히 낡은 버전이 찍히고 어떤 테스트도 잡지 못한다. updateRegistry가 이미 state.schema.json을 로드하므로(L188) 추가 I/O 없이 고칠 수 있다. 교차검증 2건 모두 Confirmed. | updateRegistry가 이미 읽는 stateSchema에서 properties.schemaVersion.default를 읽어 상수 대신 쓰거나, AC-1/AC-2와 같은 형태로 두 값의 일치를 단언하는 드리프트 가드를 tests/run-smoke.mjs에 추가하십시오. |
| 7 | `scripts/write-artifact.mjs:88`-110 | Correctness | PREV_ARTIFACT_UNREADABLE 메시지가 --force 강행 시 locked 노드 전멸을 경고하지 않음<br><br>inspectPreviousArtifact가 읽기 실패(L92-98) 또는 JSON 파싱 실패(L101-110)에서 prev:null과 함께 UNREADABLE을 반환하고, --force로 이 HOLD를 넘기면 mergeArtifact(layer, null, draft)가 prevNodes=[]로 돌아 locked 생존자 복원 루프(L316-318)가 아무것도 살리지 못한다 — AC-16이 재생성 간 보존을 약속한 locked:true 노드까지 전부 사라지고 복구 수단은 .bak 1세대뿐이다. main()의 L266-268 주석은 이 결과를 스스로 인정하지만, 사용자에게 보이는 메시지는 비대칭이다: PREV_ARTIFACT_EDITED 메시지(L134)는 '.bak 1세대를 남깁니다'까지 안내하는 반면 UNREADABLE 두 경로의 메시지(L97, L108)는 강행 결과를 한 줄도 언급하지 않는다. 교차검증 2건 모두 Confirmed. | UNREADABLE 두 경로의 hold.message에 '--force로 강행하면 병합할 prev가 없어 locked 노드를 포함한 이전 산출물 전체가 draft로 대체되며 .bak 1세대만 남는다'는 경고를 추가하십시오. |
| 8 | `scripts/write-artifact.mjs:88`-140 | Testing | PREV_ARTIFACT_UNREADABLE·PREV_ARTIFACT_HASH_MISSING 보류 사유가 검증되지 않음<br><br>inspectPreviousArtifact는 세 보류 코드를 판정하는 export 함수인데(L97 읽기 실패, L108 파싱 실패, L119 해시 부재, L131 편집 감지) WA-9는 PREV_ARTIFACT_EDITED 하나만 유발한다. 깨진 JSON 경로와 contentHash 부재 경로(fail-closed 주석까지 달린 L112-123)는 diff 어디에서도 실행되지 않는다. 두 사유 모두 깨진 텍스트를 심거나 필드를 제거하는 것만으로 결정적으로 재현 가능하다. 교차검증 2건 모두 Confirmed. | 기존 career.json 자리에 깨진 JSON을 심어 exit 3 + PREV_ARTIFACT_UNREADABLE을 확인하는 테스트와, contentHash 필드를 제거한 유효 JSON을 심어 exit 3 + PREV_ARTIFACT_HASH_MISSING을 확인하는 테스트를 WA 스위트에 추가하십시오. |
| 9 | `scripts/write-artifact.mjs:92`-98 | Correctness | 읽기 권한 오류를 found:true로 오분류 — --force 시 writeBackup이 미처리 예외로 죽어 exit 1로 위장됨<br><br>inspectPreviousArtifact의 첫 catch(L92-98)는 ENOENT가 아닌 모든 오류(EACCES/EPERM/EISDIR 등)에서 found:true를 반환한다 — 실제로는 파일 존재 여부조차 확인하지 못한 상태다. main()의 L289-292는 `hold !== null && force && found`일 때 writeBackup(filePath) → fs.copyFileSync를 호출하는데, 애초에 읽기가 실패한 바로 그 이유로 복사도 실패해 try/catch 없이 던진다. 두 교차검증이 원 발견을 한 단계 강화했다: Node의 미처리 예외 종료 코드는 1이므로 이 크래시는 '문서화되지 않은 코드'가 아니라 문서화된 exit 1('계약·스키마 위반 — 출력을 고쳐 다시 부른다')로 **위장**되어, 호출자를 무의미한 '출력 수정 후 재시도' 루프로 유도한다. 다만 writeBackup(L290)이 writeJsonAtomic(L294)보다 앞이라 '쓰지 않았다' 불변식 자체는 우연히 유지된다. | writeBackup 호출을 try/catch로 감싸 실패 시 `[HOLD] PREV_ARTIFACT_BACKUP_FAILED`류 메시지와 exit 3(쓰지 않았고 사람 확인 필요)으로 떨어뜨리고, inspectPreviousArtifact가 ENOENT 외 오류를 '존재 여부 미확인' 상태로 별도 구분해 강행 로직이 '읽힘'과 '읽기 실패'를 혼동하지 않게 하십시오. |
| 10 | `scripts/write-artifact.mjs:162`-196 | Architecture | state.json 레지스트리 read-modify-write에 동시성 제어가 없어 갱신 유실 가능<br><br>updateRegistry는 readState(L164) → 병합 → writeState(L194)를 락 없이 수행한다. writeJsonAtomic은 개별 쓰기의 원자성만 보장하고 RMW 구간 자체는 원자적이지 않아, 두 프로세스가 겹치면 나중 쓰기가 먼저 기록된 다른 계층의 artifacts 항목을 통째로 지우고도 양쪽 모두 exit 0을 반환한다(레포 전체에 lockfile/flock/O_EXCL류 메커니즘 없음 — 3중 grep 확인). 산출물 파일은 contentHash 기반 편집 감지로 신중히 보호되는데 그것을 가리키는 레지스트리는 무보호라는 비대칭이 있다. 심각도는 교차검증으로 major→minor 조정: 4개 계층은 각 계층이 이전 계층 산출물을 입력으로 받는 순차 의존 파이프라인이라 동일 루트 병렬 쓰기는 설계된 흐름 밖이고, 유실 대상이 레지스트리 항목뿐이라 해당 계층 재실행으로 복원 가능하며, 단일 사용자 로컬 CLI다. | 읽은 시점의 updatedAt(또는 별도 revision)을 기억해 두었다가 쓰기 직전 재확인하는 compare-and-swap 루프로 바꾸거나, `<root>/.state.lock`을 O_EXCL로 잡았다 푸는 파일 락으로 RMW 구간을 직렬화하십시오. |
| 11 | `scripts/write-artifact.mjs:256`-257 | Security | --root/--in/--out 경로 인자에 저장 루트 경계 검증이 없음<br><br>write-artifact.mjs L256 `path.resolve(opts.root)`와 project-ledger.mjs L79-95·L113-115의 --root/--in/--out은 값을 검증 없이 그대로 읽기·쓰기 경로로 쓴다 — 그 경로가 실제 devcareer 저장 루트(store.mjs의 resolveStorageRoot가 정한 값) 하위인지 확인하지 않는다. 이 레포는 '마크다운 프롬프트가 계약을 우회하거나 잘못된 값을 조립할 수 있다'를 명시적 위협 모델로 채택하고 write-artifact.mjs를 유일한 쓰기 경계로 선언했으므로, 이 경계에만 검증이 없는 것은 일관성 결함이다. 오케스트레이션이 잘못된 --root/--out을 넘기면 두 스크립트는 임의 경로에 JSON을 쓰고 기존 파일을 .bak으로 복제하며 state.json을 새로 만든다. 교차검증 2건 모두 Confirmed(store.mjs에 STATE_DIR_NAME·resolveStorageRoot가 이미 있어 대조가 저렴하다는 점도 확인). | resolveStorageRoot로 계산한 신뢰 루트와의 일치 또는 경로에 STATE_DIR_NAME(.devcareer) 세그먼트가 포함되는지를 확인하는 방어적 검사를 추가하십시오. 단, 현행 스모크 테스트가 os.tmpdir 밑 임의 루트(devcareer-writer-*)로 스크립트를 호출하므로, 채택 시 테스트용 우회 수단(환경변수 또는 명시적 --allow-root)을 함께 설계해야 합니다. |
| 12 | `scripts/write-artifact.mjs:282`-287 | Architecture | prev 유래 노드의 스키마 위반이 exit 1로 나가 '출력을 고쳐 재시도'라는 잘못된 복구 절차를 지시<br><br>스키마 검증(L282)은 draft가 아니라 병합 결과(merged)에 대해 수행되는데 merged에는 prev에서 온 요소가 섞인다 — locked 생존자 노드(mergeArtifact L274, L318)와 prev에서 이어받은 origin(L297). 이 요소가 스키마를 위반하면 exit 1이 나가지만, 종료 코드 문서(L33)는 exit 1의 복구 절차를 '출력을 고쳐 다시 부른다'로 못 박았다. 구체 경로: 사용자가 노드를 손으로 고치며 잘못된 필드 값과 locked:true를 함께 넣음 → PREV_ARTIFACT_EDITED 보류 → --force 강행 → 병합이 그 locked 노드를 merged에 실음 → 스키마 위반. 또는 스키마 버전 진화로 과거 locked 노드가 새 스키마에 부적합해지는 경우. 이때 draft는 완전히 유효하므로 출력을 아무리 고쳐도 영원히 exit 1이고, '코드별로 호출자의 조치가 다르다'는 5분기 계약이 이 경로에서 무너진다 — 실제 필요한 조치는 exit 3과 같은 '사람 결정'이다. | 스키마 오류의 instancePath가 가리키는 노드가 prev 유래(locked 생존자 또는 draft에 없던 id)인지 판별해 그 경우 exit 3으로 분기하거나, 최소한 오류 메시지에 '이 위반은 이전 산출물의 locked 노드에서 왔으며 출력 수정으로 해소되지 않는다'를 명시하십시오. 잘못된 locked 편집 + --force로 이 경로를 유발하는 스모크 테스트도 함께 추가하십시오. |

### Suggestions

| # | File:Line | Category | Description | Suggestion |
|---|-----------|----------|-------------|------------|
| 1 | `scripts/lib/artifact-contract.mjs:94`-106 | Maintainability | computeArtifactContentHash가 instance 부재에 fail-closed하지 않음<br><br>layer 인자가 지원 범위 밖이면 명시적으로 던지지만(L96-100), instance가 null·undefined이거나 객체가 아니면 던지지 않는다. `canonical[key] = instance?.[key]`가 전부 undefined를 대입하고 JSON.stringify가 undefined 값 프로퍼티를 생략하므로 사실상 '{}'의 SHA-256인 그럴듯한 64자 hex를 조용히 반환한다 — 이 모듈이 표방하는 fail-closed 원칙과의 비대칭이다. 교차검증 2건 모두 Confirmed하되, 현재 호출 경로에서는 inspectPreviousArtifact가 contentHash 문자열 존재를 먼저 확인하고(L112) 나머지 호출자도 JSON.parse 결과를 넘기므로 실제 노출 경로가 좁은 잠재 결함이다. | instance가 null이거나 typeof가 object가 아니면 layer와 마찬가지로 명시적 Error를 던지는 가드를 추가하고, 그 경로를 단언하는 AC 테스트를 하나 추가하십시오. |
| 2 | `scripts/project-ledger.mjs:43` | Architecture | 원장 파일명 정본이 생산자가 아니라 소비자 CLI에 선언되어 있고 드리프트 가드가 없음<br><br>이번 diff가 project-ledger.mjs L43에 `export const EVIDENCE_FILE_NAME = "evidence.json"`을 '원장 파일 이름 정본'으로 새로 만들었지만, 실제 생산자인 collect-git-facts.mjs L570은 리터럴 "evidence.json"을 독립적으로 들고 있다. 정본이 소비자 쪽에 살고 생산자가 그것을 참조하지 않는 역전 구조이며, 상수의 거처가 lib이 아닌 CLI 스크립트라는 점은 artifact-contract.mjs가 KNOWN_LAYERS import를 거부하며 명시한 의존 방향 원칙(계약 상수는 lib에, CLI가 import)과도 어긋난다. 수집기 쪽 이름이 바뀌면 --root 모드가 런타임 INPUT_ERROR로만 드러나는데, 그 --root 모드가 하필 미테스트다. 두 교차검증이 독립적으로 같은 발견을 제출했다. 파일명 변경 가능성이 낮고 불일치 시 시끄럽게 실패하므로 영향은 낮다. | EVIDENCE_FILE_NAME을 STATE_FILE_NAME·CONFIG_FILE_NAME을 이미 소유한 scripts/lib/store.mjs로 옮기고 collect-git-facts.mjs와 project-ledger.mjs가 모두 import하게 하십시오. 당장 옮기지 않는다면 최소한 두 리터럴의 일치를 단언하는 스모크 가드를 추가하십시오. |
| 3 | `scripts/write-artifact.mjs:None` | Architecture | CLI 인자 파싱·isMainModule 상투구가 스크립트 6개에 반복됨<br><br>write-artifact.mjs와 project-ledger.mjs 모두 거의 동일한 `for (let i = 0; i < argv.length; i++) switch(...)` 파싱 루프와 `import.meta.url === pathToFileURL(process.argv[1]).href` isMainModule IIFE를 각자 다시 적는다. 교차검증 재확인 결과 이 패턴은 원 보고의 5개가 아니라 6개 파일(collect-git-facts, project-ledger, render-markdown, validate-plugin, verify-evidence, write-artifact)에 있어 지적이 오히려 강화된다. 이번 diff가 사본을 2개 늘렸고 §9가 계층 확장을 예정하고 있어 반복이 계속될 가능성이 크다. | 당장 리팩터링이 급하지는 않습니다. 스크립트가 한두 개 더 늘어나는 시점에 scripts/lib/cli.mjs로 argv 파싱 헬퍼와 isMainModule 체크를 공통화하십시오. |
| 4 | `scripts/write-artifact.mjs:261` | Design | 보류 세부 사유를 기계 판독용으로 구조화하면 좋음(현재 형식도 파싱 가능)<br><br>inspectPreviousArtifact는 성격이 다른 세 보류 사유를 구분해 반환하지만 main()은 exit 3 하나로 뭉뚱그리고 세부 코드는 stderr 문자열로만 남긴다. 원 보고는 '자연어 문장에서 정규식으로 코드를 뽑아내야 한다'고 봤으나 교차검증 2건이 이 전제를 반박해 minor→suggestion으로 하향됐다: 실제 출력은 `[HOLD] ${code}: ${message}`(L261)로 코드가 `[HOLD] ` 접두 바로 뒤 고정 첫 토큰이고, 파일 헤더(L36)도 이 채널을 계약으로 문서화하며, [INPUT_ERROR]/[SCHEMA]/[MERGE]/[AUTHORSHIP]와 동일한 레포 관례다. 스모크 테스트도 접두 매칭(`stderr.includes("PREV_ARTIFACT_EDITED")`)으로 소비한다. 따라서 현재 형식이 파싱 불가능하다는 진단은 성립하지 않고, 남는 것은 개선 여지뿐이다. | 향후 호출자가 사유별로 다르게 분기할 필요가 생기면 `--json` 플래그로 {code, message} 구조를 stdout에 내보내는 옵션을 추가하십시오. 지금 당장의 변경은 필요하지 않습니다. |
| 5 | `tests/run-smoke.mjs:None` | Testing | --stage draft 성공 쓰기 경로(특히 attempts 재사용)가 전혀 실행되지 않음<br><br>runWriter 헬퍼가 `"--stage", "fact-checked"`를 하드코딩하고, --stage draft로 writer를 실행하는 곳은 WA-8(기입 주체 위반 거부, 2417행)과 WA-13(입력 파일 부재, 2483행)뿐이라 draft 단계의 성공 쓰기 경로는 어떤 오라클도 실행하지 않는다. 특히 prev.verification.attempts>=1인 노드를 같은 id로 재작성하는 케이스가 미실행이며, 이 공백이 이 리뷰의 major 발견(draft 단계 계약 3중 자기모순)이 14개 WA 오라클을 전부 통과한 채 남은 직접 원인이다. 교차검증 2건 모두 Confirmed. | prev의 verification.attempts>0인 노드를 --stage draft로 동일 id 재작성하는 케이스를 추가해, 성공해야 하는지 항상 실패해야 하는지를 오라클로 명시적으로 고정하십시오 — major 발견의 수정 방향이 결정되면 그 결정을 이 테스트가 잠급니다. |

## 오케스트레이터 실측 기록

리뷰어 보고를 그대로 받지 않고 3건을 직접 실행했다. 재현 절차와 관측값:

| 발견 | 절차 | 관측 |
|---|---|---|
| M-1 | `--stage fact-checked`로 `attempts:1` 노드를 쓴 뒤, 같은 id를 `--stage draft`로 4가지 방식으로 재작성 | (A) not-attempted/0 → exit 1 `VERIFICATION_ATTEMPTS_RESET` · (B) not-attempted/1 → exit 1 `[SCHEMA] $.nodes[0].verification.attempts: const 불일치(기대 0)` · (C) verified/1 → exit 1 `VERIFICATION_SET_BY_TEMPLATE` · (D) 새 id → exit 1 `NODE_ID_CHURN` |
| M-2 | 저장 루트에 `{broken` 을 `state.json`으로 심고 정상 draft 쓰기 | exit **4** · `career.json` 기록됨 **True** · `state.json` 원문 보존 **True** · `[REGISTRY] 기존 state.json을 읽을 수 없어…` 출력. `grep -c "status === 4" tests/run-smoke.mjs` → **0** |
| M-3 | v1에 `car:001`(비잠금)·`car:002`(잠금)을 쓴 뒤 `nodes` 필드가 아예 없는 draft 투입 | exit **0** · 결과 노드 `['car:002']` — `car:001`이 경고·`.bak` 없이 사라짐 |

## Statistics

| Severity | Count |
|----------|-------|
| Critical | 0 |
| Major | 3 |
| Minor | 12 |
| Suggestion | 5 |
| **Total** | **20** |

## Round Verdict

| Round | Critical | Major | Minor | Suggestion | Verdict |
|-------|----------|-------|-------|------------|---------|
| 1 | 0 | 3 | 12 | 5 | CONDITIONAL PASS |

Round Verdict는 조언이다 — 다음 라운드를 돌릴지는 사람이 정한다. 리뷰 행동의 권위는
`## Assessment` 줄이다.

## Files Reviewed

| File | Lines Changed | Findings |
|------|--------------|----------|
| `scripts/lib/artifact-contract.mjs` | +322 / -0 | 5 |
| `scripts/project-ledger.mjs` | +135 / -0 | 3 |
| `scripts/write-artifact.mjs` | +317 / -0 | 11 |
| `tests/run-smoke.mjs` | +616 / -0 | 1 |

## Notes

- 리뷰 범위는 사용자가 좁혔다: 슬라이스 A 파일(`collect-git-facts.mjs`·`validate-plugin.mjs`·
  `verify-evidence.mjs`·`schemas/`)의 재검토는 **명시적 제외**다 — 그쪽은 별도 큐(콜드 리뷰 T4
  14건)이며 `slice_plan.md`가 슬라이스 C로 이연을 기록했다.
- 심각도 승격 1건(M-3)은 오케스트레이터 판단이며 근거는 위 실측 표다. 나머지 19건의 심각도는
  세그먼트가 낸 값 그대로다.
- 세그먼트의 `filesReviewed`는 10건으로 보고됐다(리뷰어가 문맥 확인을 위해 읽은 주변 파일 포함).
  위 표는 **변경 대상 4건**만 센다.
