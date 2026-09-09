# Otter

로컬 우선 AI 개발 작업 관리 도구입니다. 실제 Git 저장소와 worktree, 개발 작업(Work Unit),
Codex/Claude 세션, 에이전트 팀의 인계 기록을 한곳에서 확인합니다.

> Git records the resulting code. Otter records and controls the AI-assisted work that produced it.

## 주요 기능

- 실제 Git 데이터 기반 Workspace Map: 브랜치, HEAD, ahead/behind, 변경 파일.
- Work Unit 마법사: 작업 설명, 기준 브랜치, 새 worktree, Planner/Builder/Reviewer 팀.
- 프로필/모델/역할 편집, 에이전트 시작·중지, `@AgentName` 메시지 전달.
- 단계별 워크플로와 영구 보존되는 계획·결과·구조화된 인계 기록.
- Codex/Claude JSONL 가져오기와 Conversation/Actions/Files/Commands/Timeline/Raw 탭.
- SQLite FTS5 검색 및 해당 작업/세션/이벤트로 이동.
- 인증된 프로젝트/worktree 터미널, 변경 파일 중복 경고, 측정 가능한 병합 상태.
- 재시작 복구, 증분 가져오기, 실행 상태 재조정.
- 유료 호출 없는 **FakeProvider**. 활동과 결과는 합성이라고 표시합니다.

## 홈서버에서 확인

이 작업에서 준비한 홈서버 인스턴스가 실행 중이라면 먼저 `./scripts/url`로
접속 주소를 확인하세요. 이미 실행 중인 상태에서 개발 서버를 중복 시작할 필요는 없습니다.

서버의 기존 Node/Rust 설치를 바꾸지 않고 Docker와 Compose로 개발 환경을 준비합니다.

```bash
cd /home/heejin/workspace/otter
./scripts/dev
```

첫 실행은 이미지와 의존성을 준비합니다. 이후 데몬과 UI를 빌드해
`127.0.0.1:4317`에서 실행하며 개인 접속 URL을 출력합니다. 다른 포트는
`OTTER_BIND=127.0.0.1:4318 ./scripts/dev`처럼 지정합니다.

자신의 PC에서 SSH 포워딩을 열고 계속 유지합니다:

```bash
ssh -N -L 4317:127.0.0.1:4317 heejin@192.168.0.40
```

서버 터미널에서 `./scripts/url`로 확인한 URL을 **자신의 PC 브라우저**에서 엽니다.
형식은 `http://127.0.0.1:4317/#token=...`입니다. 토큰은 데몬 재시작 때 바뀌므로
공유하지 마세요. 서버의 SSH 주소가 다르면 위 주소를 바꾸면 됩니다.

UI에 추가하는 저장소 경로는 **데몬이 실행되는 서버의 경로**입니다.
예: `/home/heejin/workspace/otter`. 외부 공개 포트는 필요하지 않습니다.
Windows/macOS PC에서도 SSH와 브라우저로 사용할 수 있습니다.

## 배포 파일 다운로드

```bash
./scripts/build
./scripts/build-desktop
```

| 결과                                           | 용도                                                     |
| ---------------------------------------------- | -------------------------------------------------------- |
| `artifacts/otter-linux-x86_64.tar.gz`          | Linux 서버/PC용 데몬 + 웹 UI. Node/Rust/Docker 없이 실행 |
| `artifacts/desktop/Otter_0.1.0_amd64.AppImage` | Linux 데스크톱 앱                                        |
| `artifacts/desktop/Otter_0.1.0_amd64.deb`      | Debian/Ubuntu 데스크톱 설치 패키지                       |

자신의 PC에서 다운로드:

```bash
scp heejin@192.168.0.40:/home/heejin/workspace/otter/artifacts/otter-linux-x86_64.tar.gz .
scp heejin@192.168.0.40:/home/heejin/workspace/otter/artifacts/desktop/Otter_0.1.0_amd64.AppImage .
```

최종 소스 스냅샷은 `artifacts/otter-source.tar.gz`, 배포 파일 체크섬은
`artifacts/SHA256SUMS`에 있습니다. 소스는 로컬 Git의 최종 커밋 기준이며,
PRD에 따라 별도 요청 없이는 새 구현 커밋을 원격으로 푸시하지 않습니다.

Linux에서 압축 배포본 실행:

```bash
tar -xzf otter-linux-x86_64.tar.gz
cd otter-linux-x86_64
./otter
```

실행 중인 인스턴스의 접속 URL은 `./otter --url`로 확인합니다.
AppImage는 실행 권한을 준 뒤 실행합니다. FUSE가 없다면
`./Otter_0.1.0_amd64.AppImage --appimage-extract-and-run`을 사용합니다.
데스크톱 앱은 GUI 디스플레이가 필요합니다. 현재 패키지는 Linux x86_64용이며
Windows/macOS 네이티브 패키지는 이 Linux 서버에서 만들지 않습니다.

## 첫 사용 순서

1. **Projects → Browse folders…**에서 초기 커밋이 있는 Git 저장소 폴더를 선택하고 **Add project**로 추가합니다. 직접 경로 입력도 가능합니다. 홈서버 브라우저 모드에서는 서버의 폴더를 탐색하며 파일을 업로드하지 않습니다.
2. Workspace Map에서 현재 브랜치와 작업공간을 확인합니다.
3. **New Work Unit**으로 작업 설명·기준 브랜치·새 worktree를 정합니다.
4. 기본 FakeProvider 팀으로 **Start Planner** → 결과 확인 → **Start Builder** → **Start Reviewer**를 실행합니다.
5. 세션 탭과 Search에서 결과를 찾습니다. 재시작 후에도 기록이 남습니다.
6. 실제 작업에는 설치·인증된 제공자의 프로필을 선택합니다.

Projects의 **Registered projects**에서 등록된 저장소를 열거나 **Remove from Otter**로
등록만 해제할 수 있습니다. 확인 후에도 실제 디렉토리, 파일, Git 브랜치와 워크트리는
변경하지 않으며 기존 Work Unit·세션 기록과 실행 중인 작업도 유지됩니다.
같은 경로를 다시 추가하면 기존 등록을 복원합니다. 이미 등록된 경로는 중복 생성하지
않고 기존 프로젝트를 엽니다.

## Codex / Claude 연동

데몬 PATH에서 CLI를 감지합니다. 현재 서버에서 관찰한 Codex는 `codex-cli 0.153.4`이며
Claude Code는 설치되어 있지 않습니다. CLI 감지는 계정 인증이나 모델 이용 권한을
보장하지 않습니다. 실행 오류는 에이전트와 세션에 표시됩니다.

Codex는 `exec --json`으로 실행하고 Planner/Reviewer에는 read-only,
Builder에는 workspace-write sandbox를 요청합니다. sandbox 우회 옵션은 사용하지
않습니다. Claude는 설치된 CLI 기능을 감지하며 역할 정책의 강제 여부를 구분합니다.
제공자 기본 모델 또는 계정에서 지원하는 모델 ID를 사용할 수 있습니다.

기본 가져오기 위치는 `~/.codex/sessions`, `~/.codex/archived_sessions`,
`~/.claude/projects`입니다. 파일은 읽기 전용으로 가져오고 10초마다 제한된 배치를
처리합니다. 특정 JSONL 파일을 직접 가져올 수도 있습니다.
Session history 제목은 Codex의 `session_index.jsonl`에 저장된 주제명을 우선
사용합니다. 별도 제목이 없으면 환경 정보와 코드 블록을 제외한 사용자 요청에서
최대 48자의 짧은 제목을 추출합니다. 기존 세션과 Codex에서 변경한 제목도 다음
스캔에 갱신되며, 별도 AI 호출이나 원본 세션 파일 수정은 하지 않습니다.
`OTTER_CODEX_BIN`/`OTTER_CLAUDE_BIN`, 세션 경로 설정 등은
[Provider adapters](docs/PROVIDER_ADAPTERS.md)를 참고하세요.

Otter는 메시지 라우팅에 추가 LLM을 사용하지 않습니다. **실제 제공자 실행은 해당
제공자의 계정/서비스를 사용**합니다. FakeProvider 테스트는 유료 호출을 하지 않습니다.

## 개발 및 검증

처음 복제했다면 `./scripts/dev`로 개발 환경을 먼저 준비합니다.

```bash
./scripts/check        # Rust formatting/Clippy, TypeScript, ESLint
./scripts/test         # Rust integration tests + frontend tests
./scripts/e2e          # Chromium workflow, search, restart and terminal
./scripts/build        # production daemon + web archive
./scripts/build-desktop
./scripts/in-dev node scripts/desktop-smoke.mjs  # packaged AppImage/Xvfb lifecycle
node scripts/release-smoke.mjs   # 실제 압축 배포본의 추출·실행·종료
```

`./scripts/in-dev bash`로 격리된 개발 셸을 열 수 있습니다. 상세 절차는
[Development](docs/DEVELOPMENT.md), 구조는 [Architecture](docs/ARCHITECTURE.md),
저장 모델은 [Data model](docs/DATA_MODEL.md)에 있습니다.

## 데이터와 개인정보

Linux 브라우저 모드 기본 데이터는 `~/.local/share/otter/`입니다.
데스크톱은 Tauri의 `dev.otter.desktop` 앱 데이터 디렉토리를 사용합니다.
`OTTER_DATA_DIR`로 변경할 수 있으며 Unix에서는 private(700) 디렉토리여야 합니다.
테스트는 임시 데이터베이스와 임시 Git 저장소를 사용합니다.

SQLite에는 세션 원본·정규화된 이벤트·작업·인계 기록이 저장됩니다. 원본 제공자
세션 파일은 수정하지 않습니다. 텔레메트리를 보내지 않으며 `.env` 내용이나 인증 파일을
수집하지 않습니다. 환경 지문은 `.env` 존재 여부만 기록합니다. 숨겨진 모델 사고를
복원하지 않으며 명시적으로 공개된 요약만 표시합니다.

데몬 로그는 JSON 형식 stdout입니다. 프롬프트·토큰·전체 환경을 로그로 남기지 않습니다.
이번 홈서버 백그라운드 인스턴스의 로그는 `~/.local/share/otter/otterd.log`입니다.
OS 시작 서비스로 설치하지 않았으므로 서버 재부팅 후에는 다시 실행해야 합니다.
런처가 출력하는 개인 접속 URL은 안전하게 취급하세요. 백업은 데몬 종료 후 데이터
디렉토리를 복사하면 됩니다. 원본 제공자 세션은 별도로 백업하세요.

## 베타 제한 및 문제 해결

- 단계별 워크플로는 명시적으로 진행합니다. 자동 병합·브랜치 삭제는 없습니다.
- 관찰되지 않은 테스트 상태는 unknown입니다. 합성 결과는 실제 병합 준비를 증명하지 않습니다.
- 관리 에이전트는 one-shot 실행입니다. 제공자 네이티브 resume/대화형 에이전트 PTY는
  비활성화되어 있습니다. 일반 작업공간 PTY 터미널은 동작합니다.
- 미분류 레코드는 Raw에 보존합니다. 4 MiB를 넘는 단일 JSONL 줄은 오류로 표시합니다.
  마지막 미완성 줄은 다음 주기에 다시 읽습니다.
- 재연결에는 `./scripts/url`의 새 토큰을 사용하세요.
- 포트가 사용 중이면 다른 localhost 포트를 선택하세요. 기존 서비스를 종료하지 않습니다.
- CLI가 보이지 않으면 데몬 PATH 또는 제공자 실행 파일 설정을 확인하세요.
- LXC에서 제공자 sandbox 실행이 거부되면 해당 제공자의 격리 요구사항을 확인하세요.
  Otter가 자동으로 보호 설정을 해제하지 않습니다.

실제 검증 결과와 남은 제한 사항: [BETA_STATUS.md](BETA_STATUS.md). 원 요구사항: [PRD](PRD.md).
