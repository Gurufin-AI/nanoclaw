# NanoClaw Discord 전용 서버 연동 가이드

## 목적

현재 Telegram으로 사용 중인 NanoClaw의 Alice를 Discord의 개인 전용 서버에도 연결한다.

Telegram은 빠른 개인 대화와 알림 채널로 유지하고, Discord는 조사·보고서·프로젝트 대화를 채널과 스레드로 정리하는 작업 공간으로 사용한다.

## 권장 구성

처음에는 Discord 서버에 `#alice` 텍스트 채널 하나만 만들고 기존 Alice agent group에 연결한다.

```text
Telegram DM ───────────────┐
                           ├─ Alice agent group
Discord 전용 서버 / #alice ┘   ├─ 공용 workspace
                               ├─ 공용 instructions
                               └─ 공용 memory/
```

- Telegram과 Discord는 동일한 Alice의 워크스페이스와 장기 메모리를 공유한다.
- 플랫폼과 메시징 그룹별 대화 세션은 분리된다.
- 따라서 Telegram의 직전 대화 문맥이 Discord에 그대로 이어지지는 않지만, 저장된 장기 메모리는 양쪽에서 사용할 수 있다.
- 향후 필요할 때만 `#reports`, `#automation`, `#research` 같은 채널을 추가한다.

## 전용 Discord 서버를 권장하는 이유

- 기존 커뮤니티 서버의 사용자·권한·메시지와 분리할 수 있다.
- NanoClaw 봇에 필요한 권한만 제한적으로 부여할 수 있다.
- 채널과 스레드로 주제별 대화를 정리할 수 있다.
- 자동 알림과 일반 대화를 별도 채널로 분리하기 쉽다.
- 나중에 다른 agent group이나 사용자를 추가할 때 정보 경계를 설계하기 쉽다.

## Telegram 대비 주요 장점

| 항목 | Telegram | Discord 전용 서버 |
|---|---|---|
| 기본 용도 | 빠른 개인 대화와 알림 | 구조화된 AI 작업 공간 |
| 대화 구조 | 연속된 단일 흐름 | 채널·스레드별 주제 분리 |
| 세션 관리 | 메시징 그룹 중심 | 채널과 스레드별 독립 세션 |
| 장기 메모리 | Alice 메모리 공유 | 동일한 Alice 메모리 공유 |
| 자료 정리 | 시간순으로 누적 | 프로젝트·보고서별 정리 가능 |
| 스레드 | NanoClaw Telegram adapter는 미지원 | Discord adapter에서 지원 |
| 권한 관리 | 개인·그룹 채팅 중심 | 역할과 채널별 권한 설정 가능 |

Discord 서버 채널의 기본 동작은 다음과 같다.

- `@Alice` 멘션으로 대화를 시작한다.
- 기본 engage mode는 `mention-sticky`다.
- Discord 스레드 안에서 대화를 시작하면 같은 스레드의 후속 메시지는 매번 멘션하지 않아도 이어진다.
- 스레드별 대화 문맥은 분리되지만 Alice의 장기 메모리와 워크스페이스는 공유한다.
- Discord의 2,000자 메시지 제한을 넘는 답변은 adapter가 분할해 전송한다.

## 1. Discord 전용 서버 만들기

1. Discord에서 새 개인 서버를 만든다.
2. 서버에는 본인만 참여한 상태로 시작한다.
3. `#alice` 텍스트 채널을 만든다.
4. 처음에는 채널을 하나만 연결한다. 실제 분리 필요성이 생겼을 때 채널을 추가한다.

## 2. Discord Application과 Bot 만들기

1. [Discord Developer Portal](https://discord.com/developers/applications)에 접속한다.
2. **New Application**을 선택하고 이름을 지정한다. 예: `NanoClaw Alice`.
3. **Bot** 메뉴에서 Bot을 추가한다.
4. **Reset Token**을 눌러 Bot Token을 발급받는다.
5. **Privileged Gateway Intents**에서 **Message Content Intent**를 활성화한다.

Bot Token은 비밀정보다. 일반 채팅, 문서, Git 저장소에 기록하지 않고 NanoClaw 설치 과정의 보안 입력 단계에서만 제공한다.

Application ID, Public Key, Discord 사용자 ID는 Bot Token으로 Discord API를 조회해 자동으로 확인할 수 있으므로 수동으로 복사할 필요가 없다.

## 3. Bot을 전용 서버에 초대하기

Discord Developer Portal의 **OAuth2 → URL Generator**에서 다음 항목을 선택한다.

### Scope

- `bot`

### Bot Permissions

- Send Messages
- Read Message History
- Add Reactions
- Attach Files
- Use Slash Commands

생성된 URL을 열어 Bot을 새 전용 서버에 초대한다. 가능하면 Bot 권한을 `#alice` 채널에만 허용한다.

## 4. Server ID와 Channel ID 확인하기

1. Discord 설정에서 **App Settings → Advanced → Developer Mode**를 활성화한다.
2. 전용 서버를 우클릭하고 **Copy Server ID**를 선택한다.
3. `#alice` 채널을 우클릭하고 **Copy Channel ID**를 선택한다.

서버 채널의 NanoClaw platform ID 형식은 다음과 같다.

```text
discord:{serverId}:{channelId}
```

Server ID와 Channel ID는 Bot Token과 달리 비밀 credential은 아니다.

## 5. NanoClaw에 Discord adapter 설치하기

NanoClaw의 `/add-discord` 스킬을 사용해 다음 작업을 수행한다.

1. 공식 `channels` 브랜치에서 Discord adapter와 등록 테스트를 가져온다.
2. `src/channels/index.ts`에 Discord adapter를 등록한다.
3. 정확히 고정된 `@chat-adapter/discord@4.29.0` dependency를 설치한다.
4. 다음 credential을 설정한다.
   - `DISCORD_BOT_TOKEN`
   - `DISCORD_APPLICATION_ID`
   - `DISCORD_PUBLIC_KEY`
5. 호스트를 빌드하고 Discord registration test를 실행한다.

Bot Token 검증 과정에서 Discord API의 `/oauth2/applications/@me`를 호출해 Application ID, Public Key, Application Owner의 Discord User ID를 확인한다.

## 6. 기존 Alice에 Discord 채널 연결하기

Discord용 새 agent를 만들지 않고 기존 Alice agent group에 `#alice` 채널을 wiring한다.

권장 결과:

```text
messaging group: Discord 전용 서버의 #alice
agent group: Alice (dm-with-kaswan)
session mode: shared
engage mode: mention-sticky
threads: true
```

연결에는 `/manage-channels` 스킬을 사용할 수 있다.

개인 서버이므로 기존 Alice에 연결하는 것이 적절하다. 향후 다른 사람을 서버에 초대하고 서로 다른 정보 접근 범위가 필요해지면 별도 agent group을 만드는 것을 검토한다.

## 7. 빌드·테스트·재시작

설치 후 다음 항목을 검증한다.

```bash
pnpm run build
pnpm exec vitest run src/channels/discord-registration.test.ts
pnpm test
```

검증이 통과하면 NanoClaw 서비스를 재시작한다. 설치별 실제 서비스 이름은 환경에 따라 다를 수 있다.

현재 설치에서는 다음 unit을 사용한다.

```bash
systemctl --user restart nanoclaw.service
```

## 8. 실제 동작 확인

1. Discord의 `#alice` 채널에서 Alice Bot을 멘션한다.

   ```text
   @Alice 안녕! 연결 테스트야.
   ```

2. Alice가 정상 응답하는지 확인한다.
3. 해당 메시지에서 Discord 스레드를 만들고 후속 메시지를 멘션 없이 보낸다.
4. 같은 스레드에서 대화가 이어지는지 확인한다.
5. Telegram에서도 Alice가 계속 정상 작동하는지 확인한다.
6. 양쪽에서 저장된 장기 선호나 사실을 회상할 수 있는지 확인한다.

## 권장 운영 방식

초기에는 다음과 같이 단순하게 운영한다.

- Telegram: 빠른 개인 대화, 즉시 확인할 알림
- Discord `#alice`: 조사, 보고서, 프로젝트형 대화
- Discord 스레드: 주제별 문맥 분리

채널을 추가할 때는 각 채널이 별도 대화 세션을 만든다는 점을 고려한다. 장기 메모리는 공유되지만 채널 간 최근 대화 문맥은 자동으로 합쳐지지 않는다.

확장 예시는 다음과 같다.

```text
#alice       일반 작업과 대화
#reports     장문 보고서와 파일
#research    조사 작업
#automation  예약 작업 결과
```

필요가 확인되기 전에는 `#alice` 하나만 wiring하는 편이 관리하기 쉽다.

## 보안 체크리스트

- [ ] 전용 서버에 불필요한 사용자를 초대하지 않았다.
- [ ] Bot Token을 채팅이나 Git에 기록하지 않았다.
- [ ] Message Content Intent를 활성화했다.
- [ ] Bot 권한을 필요한 범위로 제한했다.
- [ ] 가능하면 Bot의 접근을 `#alice` 채널로 제한했다.
- [ ] 다른 사용자를 초대하기 전에 agent group의 정보 경계를 검토한다.
- [ ] credential 파일과 로컬 설치 설정이 Git에 포함되지 않았는지 확인한다.

## 준비물 요약

설치를 시작하기 전에 다음 항목을 준비한다.

- Discord 전용 개인 서버
- `#alice` 텍스트 채널
- Message Content Intent가 활성화된 Discord Bot
- Bot이 해당 서버에 초대된 상태
- Bot Token
- Server ID
- Channel ID

준비가 끝나면 `/add-discord`로 adapter를 설치하고 `/manage-channels`로 `#alice`를 기존 Alice에 연결한다.
