# Code Review Report

| Field | Value |
|-------|-------|
| Target | cc99ea9..e4e5a51 (프롬프트 계층 신설 + 게이트 B-7·E-3·E-4 닫힘, 4커밋) |
| Mode | thorough (workflow · frontier) |
| Files | 22 files |
| Lines | +1278 / -78 |
| Date | 2026-08-20 |
| HEAD | e4e5a51345763143a36b666751ba42ab57c8beef |

## Assessment: COMMENT

## Summary

프롬프트 계층 신설과 게이트 3건 닫기는 전반적으로 견고하다 — 잠금·출처·검증 축의 스키마/병합/쓰기 경계가 서로 맞물려 있고, 신규 오라클(AC-34~42, WA-18~24, SP-1~8, LP-7~10)이 실제로 통과하며 겨냥한 분기에 진입함을 두 리뷰어가 실행으로 확인했다. 다만 major 2건이 남는다: SKILL.md 7단계의 verify-evidence.mjs 호출이 --identity/--config 누락으로 문자 그대로 따르면 매번 exit 2로 죽어 이번 회차가 닫았다는 게이트 E-4의 기계적 방어가 실제로는 한 번도 실행되지 않고, write-artifact.mjs의 updateRegistry가 산출물 기록 후 비보호 예외로 exit 4를 exit 1로 위장할 수 있다 — 후자는 이번 회차가 writeBackup에서 정확히 같은 패턴을 닫았기에 일관성 결함이기도 하다. 나머지는 종료 코드 계약 누수 1건과 오라클 사각지대 2건으로, 전부 실행 재현 또는 뮤테이션 실측으로 뒷받침됐다. 교차검증에서 반증되거나 심각도가 조정된 항목은 없다.

**리뷰 구성.** 전문 리뷰어 3명(보안·정확성 / 아키텍처·설계 / DX·유지보수·테스트, sonnet) 병렬 → 각 리뷰어 결과에 대한 적대적 교차검증 3건(fable) → 종합(opus). 원 결함 6건 · 교차검증 판정 6건 · 반증 탈락 0건.

**앵커링 차단.** 리뷰어·교차검증자 모두 `git log`/`git show`/`git blame` 실행 금지, `docs/harness/f029375/review_report.md`(라운드 1)와 `docs/harness/handoff/` 읽기 금지 조건에서 작업했다. 라운드 1의 20건은 이번 판단에 들어가지 않았다.

**`--fix`는 쓰지 않았다 — 워킹 트리는 이 리뷰로 변경되지 않았다.**

## Findings

### Critical

| # | File:Line | Category | Description | Suggestion |
|---|-----------|----------|-------------|------------|
| — | — | — | 없음 | — |

### Major

| # | File:Line | Category | Description | Suggestion |
|---|-----------|----------|-------------|------------|
| 1 | `skills/career-from-git/SKILL.md:140-153 (7단계 verify-evidence.mjs 호출 블록), 관련: scripts/verify-evidence.mjs:1145-1153` | Architecture | 게이트 E-4는 '--stage 자기 선언을 verify-evidence.mjs 호출로 반증하고, SKILL.md 7단계가 그 호출을 절차에 넣는다'고 닫혔다. 그런데 7단계에 실제로 적힌 명령은 `node scripts/verify-evidence.mjs --repo <레포 경로> --evidence <원장 경로> --artifact career=<저장 루트>/career.json --sources references/sources.json`뿐으로 `--config`도 `--identity`도 없다. verify-evidence.mjs main()은 selectedIdentities가 비면(두 플래그 부재 시 항상 그렇다) `[오류] selectedIdentities가 비어 있습니다 — --config 또는 --identity로 지정하십시오.`를 찍고 exit 2로 즉시 종료한다(1150-1153행; parseArgs에 configPath 기본값 없음). 인용 검증 호출(1175행)은 그 뒤라 단 한 축도 실행되지 않는다. 교차검증이 임시 evidence/career JSON으로 이 명령을 그대로 실행해 정확히 그 오류와 exit=2를 결정적으로 재현했다. 게다가 --config를 공급할 config.json의 프로덕션 쓰기 경로가 레포에 없다 — writeConfig 정의는 scripts/lib/store.mjs:423 하나뿐이고 호출자는 tests/run-smoke.mjs가 유일하다(0단계는 '설정 파일에 저장한다'고 지시하지만 그 정본 경로가 존재하지 않는 죽은 코드 상태). 교차검증이 보탠 정황: SKILL.md:75-76이 '이후 단계의 경로는 1단계 stdout 출력에서 받아 쓴다 — 손으로 조립하지 마라'고 못박는데 config.json은 어떤 단계의 stdout에도 나오지 않으므로, 쓰기 경로 신설 없이는 --config 추가조차 규약 안에서 불가능하다. 피해는 두 겹이다. (1) 문서화된 유일한 기계적 방어가 문자 그대로 따르면 100% 실패하고, 8-9단계까지 가려면 오케스트레이터가 문서 밖에서 인자를 즉흥 수리해야 한다 — 이 스킬이 배제하려던 '절차서 밖 재량'이 바로 그 지점에서 되살아난다. (2) verify-evidence.mjs는 INPUT_ERROR와 INCONCLUSIVE를 의도적으로 같은 exit 2로 묶는데 SKILL.md:155는 exit 2를 'INCONCLUSIVE'로만 설명하므로, 종료 코드 표를 따르는 오케스트레이션이 '인자 실수'를 '증거가 불충분해 결론을 못 냈다'는 그럴듯하지만 틀린 이유로 사용자에게 보고한다. 신규 오라클 SP-5는 `allText.includes("node scripts/verify-evidence.mjs")` 부분 문자열 매칭뿐이라(run-smoke.mjs:2749-2752) 이 깨진 명령으로도 초록으로 남는다 — 이번 회차가 스스로 인정한 SP 계열 한계가 정확히 이 구멍을 놓친 사례다.<br><br>**교차검증:** Confirmed — 모든 세부 주장이 코드로 확인됐고 명령 실행으로 exit 2가 결정적으로 재현됐다. 심각도 조정 없음(major 유지): stderr 메시지가 원인을 정확히 말하고 SKILL.md:155가 멈추라고 지시하므로 fail-closed라 critical은 아니지만, 유일한 기계적 방어가 매번 실패한다는 사실 자체는 반증되지 않았다. | 가장 단순한 수정은 7단계 예시 명령에 `--identity <0단계에서 선택된 이메일> [--identity ...]`를 추가하는 것이다. `--config <저장 루트>/config.json`을 쓰려면 0단계 지시를 뒷받침할 결정적 쓰기 경로(write-artifact.mjs와 같은 스키마 자기검증+원자적 쓰기 계약을 공유하는 별도 진입점, 예: scripts/write-config.mjs)를 실제로 만들고 그 stdout으로 경로를 흘려야 SKILL.md:75-76 규약을 지킬 수 있다. 아울러 SP-5를 '명령 문자열 존재'에서 '--identity 또는 --config 플래그를 동반한 호출'까지 보도록 강화하면 같은 회귀를 소스 스캔 수준에서 다시 잡을 수 있다. SKILL.md:155의 exit 2 설명에 INPUT_ERROR도 같은 코드로 온다는 사실을 명시하는 것도 함께 권한다. |
| 2 | `scripts/write-artifact.mjs:227, 233 (updateRegistry 본체) / 364 (main()의 호출 지점)` | Correctness | 이번 회차는 --force 강행 경로의 writeBackup() 실패를 try/catch로 감싸 '미처리 예외가 문서화된 exit 1로 위장되는' 콜드 리뷰 Correctness #9 패턴을 정확히 닫았다. 그런데 같은 파일에 구조적으로 동일한 패턴이 하나 더 남아 있다. main()이 361행 `writeJsonAtomic(root, fileName, merged);`로 산출물을 디스크에 **이미 성공적으로 기록한 뒤** 364행에서 호출하는 updateRegistry(201~235행)의 두 지점이 어떤 try/catch로도 감싸여 있지 않다: 227행 `JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "schemas", "state.schema.json"), "utf8"))`와 233행 `writeState(root, state);`. writeState는 store.mjs의 writeJsonAtomic(335~341행, 역시 try/catch 없는 mkdirSync/writeFileSync/renameSync)에 그대로 위임하므로, 디스크 가득 참·권한 오류·Windows에서 다른 프로세스/백신/에디터가 state.json을 잠가 renameSync가 EPERM/EBUSY로 실패하는 경우(이 환경이 win32라 특히 현실적) 예외가 main()까지 전파되고 모듈 어디에도 핸들러가 없어 Node 기본 처리로 exit 1이 된다. 즉 파일 자신의 주석이 exit 4('산출물은 기록됐으나 레지스트리 갱신 실패')로 정의한 상황이 실제로는 exit 1('아무것도 쓰지 않았다 — 출력을 고쳐 다시 부른다')로 관측된다. SKILL.md 4단계 표가 이 코드를 그대로 신뢰해 분기하므로 오케스트레이션은 산출물이 존재하는데도 '아무것도 안 쓰였다'고 믿고 draft를 고쳐 재시도하는 무의미한 루프에 빠지거나 근본 원인(state.json 잠금/권한)을 진단하지 못한다. 교차검증이 넓힌 발현 표면: 227행은 저장 루트가 아니라 **플러그인 설치 디렉터리**의 스키마 파일을 읽으므로, 디스크·잠금 문제가 전혀 없어도 플러그인 설치 손상(스키마 파일 누락 → ENOENT throw, 훼손 → JSON.parse throw)만으로 같은 위장이 발현한다. 같은 함수 220행 `toStorageRelative`는 try/catch로 감싸 {ok:false}로 돌리면서 227·233행만 비보호인 비대칭도 확인됐다. 테스트 커버리지도 비어 있다 — 레지스트리 실패 테스트는 WA-15(run-smoke.mjs 2976행 부근, state.json을 깨진 JSON으로 만들어 readState 거부 경로만 검증) 하나뿐이고 writeState/스키마 로드가 던지는 경로는 어떤 테스트에도 없다.<br><br>**교차검증:** Confirmed — 주장된 코드가 전부 실재하고 경로 재구성이 성립함을 코드 추적으로 확인. 심각도 조정 없음(major 유지). 완화 요소 하나가 확인됐다: 오케스트레이션이 exit 1을 믿고 재시도해도 방금 쓴 산출물의 contentHash가 재계산값과 일치해 HOLD 없이 자기 산출물과 재병합되므로 사용자 데이터 유실 자체는 없다. 그러나 파일 51~53행 주석이 스스로 경고한 'exit 4를 다른 코드에 섞으면 재시도가 덮어쓰기가 된다'는 혼동을 낳고 동일 패턴이 같은 회차에 명시적으로 닫혔다는 점에서 major가 맞다. 교차검증이 227행(플러그인 설치 손상 트리거)을 발현 표면에 추가했다. | updateRegistry() 안의 227행 스키마 로드와 233행 writeState 호출을 try/catch로 감싸 실패 시 {ok:false, error:...}를 반환하게 한다 — 이번 회차가 writeBackup(340~357행)에 적용한 것과 정확히 같은 패턴이다. 그러면 main()의 기존 `if (!registry.ok) { ...; process.exit(4); }` 분기가 이 실패도 그대로 흡수해 '쓰기 성공, 레지스트리 갱신 실패'가 항상 exit 4로 보고된다. 회귀 방지를 위해 writeState가 던지는 경로(예: state.json 경로를 디렉터리로 만들어 rename 실패 유도)를 겨냥한 스모크 케이스 추가도 권한다. |

### Minor

| # | File:Line | Category | Description | Suggestion |
|---|-----------|----------|-------------|------------|
| 1 | `scripts/project-ledger.mjs:126-128` | Correctness | 이번 회차가 추가한 저장 경계 검사(101~105행)는 --root/--out이 '.devcareer' 세그먼트를 포함하는지만 확인하고 통과시킨 뒤, 실제 쓰기 지점 `fs.writeFileSync(opts.outPath, serialized, "utf8")`(127행)는 try/catch로 감싸지 않는다. 이 스크립트의 문서화된 종료 코드 계약은 38~40행 주석의 '0 = 투영 성공 / 2 = 입력 오류' 두 갈래뿐인데, --out 경로의 상위 디렉터리가 없거나 권한·디스크 문제가 있으면 미처리 예외로 문서에 없는 세 번째 코드 exit 1이 조용히 생긴다. 교차검증이 실행으로 결정적 재현: 임시 디렉터리에서 `node scripts/project-ledger.mjs --in <유효한 evidence.json> --out <.devcareer 경계 안이지만 상위 디렉터리가 없는 경로>`를 실행하자 경계 검사는 통과한 뒤 127행에서 ENOENT가 터져 Node 스택트레이스(node:fs:2414, errno -4058 등)가 여과 없이 노출되고 EXIT=1로 종료됐다. 다른 곳에서 막히지도 않는다 — checkStorageBoundary는 문자열 세그먼트만 보고 디렉터리 존재를 확인하지 않으며(store.mjs 65~73행), writeFileSync는 writeJsonAtomic과 달리 mkdirSync를 선행하지 않는다. write-artifact.mjs가 정확히 이 클래스의 버그를 이번 회차에 명시적으로 닫았는데, 같은 회차에 새로 강화된 이 파일에는 같은 보호가 빠진 일관성 결함이다. 교차검증이 보탠 두 가지: 발현 시 출력이 이 레포가 일관되게 유지하는 [INPUT_ERROR] 한국어 메시지 규약(콜드 리뷰 A-32 계열)과 형식까지 어긋나고, exit 1은 write-artifact.mjs 계약에서 '출력을 고쳐 다시 부른다'는 의미로 이미 점유된 값이라 두 스크립트를 같은 오케스트레이션이 부를 때 코드 1의 의미가 파일마다 달라지는 혼선이 생긴다.<br><br>**교차검증:** Confirmed — 실행으로 결정적 재현(EXIT=1, 스택트레이스 노출). 심각도 조정 없음(minor 유지): --out 없이 stdout으로 받는 것이 기본 용법이고 발현해도 시끄럽게 죽으며 데이터 유실이 없다. 교차검증이 [INPUT_ERROR] 규약 위반과 exit 1 의미 충돌을 근거로 보탰다. | 127행 fs.writeFileSync를 try/catch로 감싸고 실패 시 failInput류의 [INPUT_ERROR] 메시지와 exit 2로 처리한다(또는 쓰기 실패용 코드를 38~40행 주석에 새로 문서화한다). 상위 디렉터리 부재가 흔한 실수라면 writeJsonAtomic처럼 mkdirSync 선행을 넣는 것도 함께 고려할 수 있다. |
| 2 | `tests/run-smoke.mjs:2752-2760 (SP-6)` | Architecture | SP-6는 '생성 템플릿이 draft 금지 필드(verification·locked)를 이름으로 명시하는가'를 관측하는데, 대상을 2757행 `const writer = promptFiles.filter((p) => rel(p).includes("career-writer"));` + `writer.length === 1`로 **하드코딩된 파일명 하나**에 고정한다. 반면 같은 함수의 SP-7·SP-8은 `promptFiles.filter((p) => rel(p).includes("/templates/"))`로 templates/ 전체를 일반적으로 순회한다. artifact-contract.mjs:58-60 주석이 '구현 7단계 (g)가 이름을 댄 세 템플릿(CareerWriter·KnowledgeMapper·GapAnalyzer)'을 명시하고 VERIFICATION_LAYERS가 career·knowledge-map·gap-report 3계층을 export하므로, 레포 스스로 생성 템플릿 2건이 skills/skill-gap/에 추가될 것을 예고한다. 그 두 템플릿이 들어와도 SP-6는 여전히 'career-writer'만 걸러 보므로 verification/locked 금지를 문서화하지 않은 새 템플릿이 조용히 통과한다 — SP-1이 막으려 했던 '대상 0건이라 공허하게 통과' 패턴과 구조적으로 같은 사각지대의 '새 대상만 조용히 빠지는' 변종이다. SP-6의 존재 이유 자체가 2745-2748행 주석이 적은 '금지를 모르는 템플릿의 무한 재작성 루프 방지'이고 새 템플릿이 정확히 그 루프에 빠질 대상이라는 점에서 무해하지 않다. 교차검증이 보탠 자기모순: SP-3의 주석(2721행 부근)이 '테스트에 파일명을 하드코딩하면 상수가 바뀔 때 스캔이 옛 이름을 계속 찾는다'며 하드코딩을 안티패턴으로 명시하는데, SP-6는 같은 파일에서 그 원칙을 스스로 어긴다 — 의미 기준 선정에 쓸 정본 닻(VERIFICATION_LAYERS)이 이미 export돼 있는데도 그렇다.<br><br>**교차검증:** Confirmed — 코드 실재와 예고된 새 템플릿 2건 모두 확인. 심각도 조정 없음(minor 유지): 오늘 시점에서는 공허하지 않고(존재하는 유일한 생성 템플릿을 실제로 검사하며, career-writer.md가 개명되면 length===1이 깨져 시끄럽게 FAIL한다) 발현이 미래 조건부이며 쓰기 경계 집행은 별도로 살아 있다. 교차검증이 SP-3 주석과의 자기모순, 그리고 원래 수정안('/templates/ 전체 순회')의 fact-checker.md 오탐 함정을 추가로 밝혔다. | 대상 선정을 파일명 하드코딩에서 의미 기준으로 바꾸고 `writer.length === 1` 개수 단언 대신 '대상 각각이 verification·locked를 언급하는가'로 일반화한다. 단, SP-7/SP-8의 `/templates/` 필터를 그대로 복사하면 안 된다 — templates/에는 생성 템플릿이 아닌 fact-checker.md가 있고 그 출력은 verification 판정 자체를 실으므로 FactChecker 템플릿에 draft 금지 문구를 잘못 요구하게 된다. artifact-contract.mjs의 VERIFICATION_LAYERS에 대응하는 writer 템플릿 목록 같은 정본 닻을 기준으로 삼아야 한다. skill-gap 착수 시 이 오라클을 다시 열어야 한다는 점을 게이트 문서(E-3 갱신분 옆)에 남겨 두면 좋다. |
| 3 | `tests/run-smoke.mjs:2437-2450 (AC-39 블록) / 관련 프로덕션: scripts/lib/artifact-contract.mjs:370-380` | Testing | AC-39는 '병합은 기존 노드의 locked를 prev에서 이어받는다'를 검증한다고 주장하지만, 겨냥한 표현식 artifact-contract.mjs:380 `locked: prevNode.locked === true`는 그 자리에 도달하는 시점에 이미 `prevNode.locked !== true`임이 위쪽 early-return(규칙 1, 370행 `if (prevNode.locked === true) { mergedNodes.push({ ...prevNode }); continue; }`)으로 보장돼 있다. prevNode.locked를 참조하는 곳은 mergeArtifact 안의 370·380행뿐이고 같은 루프 반복의 같은 const를 보므로, 380행은 도달 가능한 모든 경로에서 리터럴 false와 동치임이 코드만으로 증명된다. 진짜 '이어받기'(true 보존)는 규칙 1이 담당하며 AC-39의 (b) 서브케이스와 AC-41이 그쪽을 검증한다. 따라서 AC-39 (a) 서브케이스(prevUnlocked, merged.locked===false 관측)는 '이어받기'와 '항상 false 하드코딩'을 구별하지 못하는 공허한 관측이다. 뮤테이션 실측으로 확정: 380행을 `locked: false`로 바꾸고 스위트를 돌리면 `433 PASS / 0 FAIL`로 AC-39를 포함해 전부 그대로 통과한다(리뷰어와 교차검증이 각각 독립적으로 재현, 레포 원본은 원복/미변경). 프로덕션 동작 자체는 올바르지만 테스트와 서술이 이 라인을 mutation-safe한 것으로 오인하게 만든다. 교차검증이 보탠 점: 378-379행 프로덕션 주석('규칙 4 — origin·locked 모두 prev의 값을 이어받는다')도 같은 방식으로 오도한다.<br><br>**교차검증:** Confirmed — 코드 도달가능성 증명과 뮤테이션 실측(433 PASS / 0 FAIL, 뮤턴트 미검출)이 독립적으로 재현됐다. 심각도 조정 없음(minor 유지, 프로덕션 동작은 정상이므로 Testing/명료성 결함). 교차검증이 프로덕션 주석의 동일한 오도를 추가로 지적하고, 원래 suggestion 중 '프로덕션을 리터럴 false로 단순화' 부분에는 리팩터링 안전성 유의점이 있다고 조정했다. | AC-39 (a) 서브케이스를 지우거나, 최소한 주석/리포트 메시지에서 '이어받는다'는 표현을 빼고 '이 분기에서는 항상 false가 나온다(비잠금 노드의 성질)'로 정정한다 — 프로덕션 378-379행 주석도 같이 손보는 것이 좋다. 다만 프로덕션 코드를 리터럴 `locked: false`로 단순화하는 것은 권하지 않는다: 현재의 중복 표현식은 규칙 1의 early-return이 향후 리팩터링으로 제거·변경돼도 올바르게 동작하는 방어적 중복이라, 리터럴로 바꾸면 그 시나리오에서 조용한 locked 유실이 생길 수 있다. 수정은 테스트/주석 서술 쪽이 안전하다. |

### Suggestions

| # | File:Line | Category | Description | Suggestion |
|---|-----------|----------|-------------|------------|
| 1 | `scripts/lib/store.mjs:65-73 (checkStorageBoundary)` | Security | checkStorageBoundary는 `path.resolve(targetPath)` 후 `split(/[\\/]+/)`로 세그먼트에 '.devcareer'가 포함되는지만 보고 fs 조회(realpathSync·lstatSync)를 전혀 하지 않는다. 따라서 `<임의 경로>/.devcareer`가 실제로는 심볼릭 링크(또는 Windows 정션)이고 저장 경계와 무관한 위치를 가리켜도 문자열 비교만으로 통과한다 — 이후 write-artifact.mjs의 mkdirSync/writeJsonAtomic(rename)과 writeBackup(185~189행)의 copyFileSync는 모두 Node 표준 동작상 링크를 따라가므로, 검사를 통과한 경로가 실경로로는 저장 루트 밖에 쓰기/백업을 수행할 수 있다. 57~60행 문서 주석의 '이것이 막지 못하는 것' 목록은 '~/.devcareer 밑 어느 하위 경로든 통과'와 '.devcareer 이름의 디렉터리를 아무 데나 만들어도 통과' 두 가지만 명시하고 심볼릭 링크 리다이렉트는 언급하지 않아, 알려진 한계 목록이 실제 한계보다 좁다.<br><br>**교차검증:** Confirmed — 코드 사실(fs 조회 없음, 주석의 한계 목록에 링크 케이스 부재, 쓰기 API가 링크를 따라감)이 전부 정확. 심각도 조정 없음(suggestion 유지): 이 검사의 선언된 위협 모델은 '오케스트레이션이 잘못된 문자열을 조립'하는 실수 방지이고, 링크를 심을 수 있는 행위자는 이미 파일시스템 쓰기 권한을 가진 로컬 주체라 문자열 검사가 방어선일 수 없다. 또한 '.devcareer 디렉터리를 아무 데나 만들어도 통과'라는 이미 수용된 한계와 같은 수용 클래스의 변형(만드는 것이 디렉터리냐 링크냐)이라 문서 보강 제안으로만 성립한다. | 실질 위험이 낮으므로 문서 주석의 '이것이 막지 못하는 것' 목록에 심볼릭 링크/정션 케이스를 명시적으로 추가해 한계를 감추지 않는 것만으로 충분하다. 더 강한 방어가 필요하면 존재하는 상위 세그먼트까지만 fs.realpathSync로 해소한 뒤 같은 세그먼트 검사를 적용하는 방법이 있다. |

## 교차검증에서 탈락한 항목

적대적 교차검증에서 반증되어 탈락한 결함은 없다(0건). 6건 모두 코드 실재 확인을 통과했고, 그중 3건은 결정적 재현까지 이뤄졌다 — SKILL.md 7단계 명령 실행 시 exit 2 재현, project-ledger.mjs --out 상위 디렉터리 부재 시 ENOENT/EXIT=1 재현, artifact-contract.mjs:380 뮤테이션 후 433 PASS/0 FAIL(뮤턴트 미검출). 심각도가 조정된 항목도 없다(6건 전부 원 심각도 유지). 다만 반증 시도가 찾아낸 완화 요소는 각 findings의 crossVerified에 남겼다: write-artifact.mjs exit 코드 위장은 재시도 시 contentHash 일치로 자기 산출물과 재병합되어 데이터 유실은 없고, SKILL.md 7단계 실패는 stderr가 원인을 정확히 말하는 fail-closed이며, SP-6는 오늘 시점에서는 공허하지 않고 career-writer.md 개명 시에는 시끄럽게 FAIL한다 — 이들이 세 건을 critical로 올리지 못하게 막은 근거다. 세 리뷰어 중 어느 쪽도 지적하지 않았지만 리뷰어가 스스로 보고 대상에서 제외한 항목이 둘 있어 참고로 남긴다: (1) EVIDENCE_FILE_NAME 정본이 project-ledger.mjs에만 있고 collect-git-facts.mjs가 \"evidence.json\" 리터럴을 독립적으로 쓰는 드리프트 가능성 — 이번 diff가 만든 것이 아닌 기존 상태라 제외. (2) makeFactCheckedNode의 locked 오버라이드 가드가 사후 스프레드를 막지 못하는 점 — 위반 데이터를 일부러 구성하는 테스트 용도로만 쓰이는 의도된 설계라 제외.

## Statistics

| Severity | Count |
|----------|-------|
| Critical | 0 |
| Major | 2 |
| Minor | 3 |
| Suggestion | 1 |
| **Total** | **6** |

## Round Verdict

| Round | Critical | Major | Minor | Suggestion | Verdict |
|-------|----------|-------|-------|------------|---------|
| 1 | 0 | 2 | 3 | 1 | CONDITIONAL PASS |

Round Verdict는 조언이다 — 다음 라운드를 돌릴지는 사람이 정한다. 리뷰 행동의 권위는 `## Assessment` 줄이다.

## Files Reviewed

| File | Lines Changed | Findings |
|------|--------------|----------|
| `README.md` | +20 / -17 | 0 |
| `docs/harness/devcareer-prep-plugin/slice_b_spec_review.md` | +99 / -14 | 0 |
| `scripts/lib/artifact-contract.mjs` | +48 / -7 | 0 |
| `scripts/lib/store.mjs` | +40 / -0 | 1 |
| `scripts/project-ledger.mjs` | +14 / -1 | 1 |
| `scripts/write-artifact.mjs` | +73 / -13 | 1 |
| `skills/career-from-git/SKILL.md` | +183 / -0 | 1 |
| `skills/career-from-git/templates/career-writer.md` | +84 / -0 | 0 |
| `skills/career-from-git/templates/fact-checker.md` | +95 / -0 | 0 |
| `tests/fixtures-invalid/24-skill-name-missing/.claude-plugin/plugin.json` | +9 / -0 | 0 |
| `tests/fixtures-invalid/24-skill-name-missing/skills/career-from-git/SKILL.md` | +9 / -0 | 0 |
| `tests/fixtures-invalid/25-skill-description-missing/.claude-plugin/plugin.json` | +9 / -0 | 0 |
| `tests/fixtures-invalid/25-skill-description-missing/skills/career-from-git/SKILL.md` | +9 / -0 | 0 |
| `tests/fixtures-invalid/26-skill-frontmatter-missing/.claude-plugin/plugin.json` | +9 / -0 | 0 |
| `tests/fixtures-invalid/26-skill-frontmatter-missing/skills/career-from-git/SKILL.md` | +4 / -0 | 0 |
| `tests/fixtures-invalid/27-skill-md-not-found/.claude-plugin/plugin.json` | +9 / -0 | 0 |
| `tests/fixtures-invalid/27-skill-md-not-found/skills/career-from-git/README.md` | +4 / -0 | 0 |
| `tests/fixtures-invalid/28-doc-path-not-found/.claude-plugin/plugin.json` | +9 / -0 | 0 |
| `tests/fixtures-invalid/28-doc-path-not-found/skills/career-from-git/SKILL.md` | +14 / -0 | 0 |
| `tests/fixtures-invalid/29-command-prefix-mismatch-in-skill/.claude-plugin/plugin.json` | +9 / -0 | 0 |
| `tests/fixtures-invalid/29-command-prefix-mismatch-in-skill/skills/career-from-git/SKILL.md` | +13 / -0 | 0 |
| `tests/run-smoke.mjs` | +515 / -26 | 2 |

리뷰어가 문맥 확인을 위해 읽은 diff 밖 파일(스키마 6종, `verify-evidence.mjs`, `collect-git-facts.mjs`, `validate-plugin.mjs` 등)은 위 표에 세지 않는다 — 변경 대상만 센다.

## Notes

**보고 안 나온 영역이 '봤는데 괜찮았다'인 경우(지적 0건의 근거 있음).** (1) 잠금·출처 계약: checkAuthorshipContract가 값이 아니라 필드 존재 여부로 판정하고 null/undefined 병합·중복 id·nodes 비배열·prev의 locked가 비boolean인 경우까지 `=== true` 엄격 비교로 안전하게 처리됨을 코드 추적으로 확인, AC-34~AC-42가 금지·허용 양방향을 모두 관측. mergeArtifact 직접 호출로 우회하는 경로도 병합 규칙 4(스프레드 뒤 locked/origin 강제 설정)로 독립 차단되며 AC-41이 이를 검증. JSON.parse가 CreateDataProperty를 쓰므로 draft의 \"__proto__\" 키를 통한 프로토타입 오염은 성립하지 않음(이론 검토). (2) 4개 스키마(career/plan/gap-report/knowledge-map)의 locked·verification required·조건절을 mergeArtifact/checkAuthorshipContract와 직접 대조 — draft/fact-checked 2단계 × 신규/기존/잠금 3경로 전부에서 두 필드가 빠짐없이 채워지고 AC-42가 스키마 재검증으로 고정, M-1류 3중 자기모순 재현 안 됨. (3) EMPTY_REGISTRY_ARTIFACTS와 state.schema.json의 artifacts.required 키 집합 일치 확인. (4) checkStorageBoundary의 `..` 상대경로 탈출은 path.resolve 사전 정규화로 이미 제거됨을 직접 재현 확인, 유사 이름(.devcareer-old)은 세그먼트 정확 일치로 거부(스모크 확인), Windows 대소문자 차이는 과잉 거부 방향이라 보안 우회 아님. (5) write-artifact/project-ledger/render-markdown/validate-plugin의 실제 CLI 인자명이 SKILL.md 1·2·4·6·8·9단계 예시와 전부 일치함을 각 parseArgs와 대조(7단계만 어긋남 = 위 major). (6) inspectPreviousArtifact의 existence 3상태 상호배타성과 --force 분기 조건 안전성 확인. (7) README 상태 표의 백틱/이탤릭 표기를 실제 파일 존재 여부와 전수 대조해 전부 일치. (8) negative 픽스처 24~29가 겨냥한 오류 코드가 validate-plugin.mjs에 실재하고 각각 의도한 절에서만 발화함을 코드 대조. (9) `npm test` 실측: 기본 433 PASS/0 FAIL, negative 33 PASS/0 FAIL로 신규 오라클 전부가 실제로 통과하고 겨냥한 분기에 진입함을 확인. **미검사로 남은 영역(안 봤음).** (a) render-markdown.mjs·schema-validate.mjs 내부 로직 — diff 대상이 아니어서 열지 않았다. (b) verify-evidence.mjs·collect-git-facts.mjs 자체의 검증/수집 로직 정확성 — 인자 계약(위 major)만 봤고 내부는 파지 않았다. (c) `npm test --golden` 모드는 골든 300커밋 픽스처 캐시의 git 툴 오류(파일 변경 집합 계산 실패)로 중단됐다 — 이 diff가 손대지 않은 경로이자 로컬 캐시 상태 문제로 보이나 **골든 구간은 실제로 그린임을 확인하지 못했다**(한 리뷰어는 3구간 exit 0을 봤다고 보고했으나 최종 요약 카운트만 tail로 캡처했고 개별 PASS 줄은 직접 보지 못했다 — 두 관측이 엇갈리므로 골든 모드는 미확인으로 남긴다). (d) SP 계열 오라클이 '명령을 실제로 실행했는가'까지는 볼 수 없다는 한계는 문서가 이미 인정하고 있어 별도 재검증하지 않았다 — 다만 그 한계가 위 major 1건을 실제로 놓쳤다.

## 오케스트레이터 실측 기록

에이전트 리포트를 그대로 받지 않았다. major 2건과 minor 1건, 그리고 위 Notes가 "미확인"으로 남긴
골든 게이트를 오케스트레이터가 직접 실행해 확인했다.

| 대상 | 절차 | 관측 |
|---|---|---|
| Major #1 | SKILL.md 7단계 명령을 **문자 그대로** 실행(`--repo . --evidence <경계 안 evidence.json> --artifact career=<career.json> --sources references/sources.json`) | `[오류] selectedIdentities가 비어 있습니다 — --config 또는 --identity로 지정하십시오.` · exit **2**. 인용 무결성 축은 **한 건도 실행되지 않았다** |
| Major #1 (후속) | `grep -rn "writeConfig" --include=*.mjs .` | 정의 `scripts/lib/store.mjs:423` 1곳 + 호출 `tests/run-smoke.mjs` 2곳. **프로덕션 호출자 0건** — `--config`를 채울 `config.json`을 쓰는 주체가 레포에 없다(0단계 4번 지시의 실행 경로 부재) |
| Major #2 | `scripts/write-artifact.mjs:201-235` 직독 | `toStorageRelative`만 try/catch로 감싸 `{ok:false}`를 돌리고, 스키마 로드(227행)와 `writeState`(233행)는 **비보호**. 같은 함수 안의 비대칭 확인 |
| Minor #3 | 저장 경계 **안**이지만 상위 디렉터리가 없는 `--out`으로 `project-ledger.mjs` 실행 | 경계 검사는 통과한 뒤 `ENOENT` 원시 스택이 그대로 노출되고 exit **1** — 이 파일이 문서화한 종료 코드 계약은 0/2 두 갈래뿐이다 |
| 골든 게이트 | `node tests/run-smoke.mjs --golden` | **11 PASS / 0 FAIL**. Notes (c)의 "골든 모드는 미확인"은 **해소된다** — 한 리뷰어가 보고한 픽스처 캐시 git 오류는 재현되지 않았고 캐시 재사용 경로가 정상 동작했다 |
| 4게이트 전량 | `npm run lint` · 스모크 · `--negative` · `--golden` | exit **0** / **433 PASS** / **33 PASS** / **11 PASS** — 전부 0 FAIL |

**심각도는 조정하지 않았다.** 라운드 1(`f029375`)에서는 오케스트레이터가 M-3을 minor→major로
올렸지만, 이번 6건은 교차검증이 낸 값 그대로다 — 실측이 리뷰어 주장을 반박하지도 강화하지도
않았고, 다만 Major #1의 후속 관측(`writeConfig` 프로덕션 호출자 0건)이 그 결함의 수정 범위가
"예시 명령 한 줄 고치기"보다 넓다는 것을 확정했다.

**Notes 항목 (c)는 위 실측으로 대체된다.** 나머지 미검사 영역 (a)·(b)·(d)는 그대로 열려 있다.
