# zca-scrape-message

Đọc lịch sử tin nhắn của các nhóm/hội thoại chỉ định từ **Zalo Desktop**
(app Windows, không phải web), chạy theo lịch (VD: Task Scheduler lúc
12:00), ghi ra file. Không gửi tin, không có listener realtime, không có
bước đăng nhập riêng của bot — chỉ đọc DOM của phiên Zalo Desktop mà bạn đã
đăng nhập sẵn theo thói quen dùng hàng ngày.

## Vì sao không dùng web (chat.zalo.me) hay API zca-js để đăng nhập

Hai hướng đã thử và bỏ:

- **Web qua Playwright + login QR của zca-js**: mỗi lần bot chạy phải xác
  thực lại (API `zalo.login()` + phiên trình duyệt), Zalo chỉ cho **1
  client hoạt động cùng lúc** nên 2 phiên này tranh nhau, phiên sau bị kick
  → phải quét QR lại liên tục.
- **Zalo Desktop**: về bản chất là app Electron (bọc cùng lõi web), DOM đọc
  được qua **Chrome DevTools Protocol (CDP)** giống hệt trình duyệt. Vì bot
  đọc thẳng vào phiên đã đăng nhập sẵn của bạn (không tự tạo phiên riêng),
  **không có bước đăng nhập/QR nào cho bot cả**, và không có xung đột client.

Playwright's `connectOverCDP` không attach thẳng được vào Electron của Zalo
Desktop (lỗi `Browser.setDownloadBehavior`, do bản CDP cũ — Electron
22/Chrome 108). Vì vậy `history/cdp.ts` tự cài một client CDP tối giản
qua WebSocket thô (`Runtime.evaluate`) thay vì dùng Playwright.

## Luồng hoạt động (mỗi lần chạy `index.ts`)

1. **`ensureZaloReady()`** (`history/desktopScraper.ts`): kiểm tra cổng
   debug CDP (`config.cdpPort`, mặc định `9222`) đã mở chưa.
   - Nếu **chưa** (trường hợp bình thường — Zalo Desktop mở theo cách thông
     thường không có cờ debug, hoặc chưa mở): tắt hẳn mọi tiến trình
     `Zalo.exe` đang chạy (`taskkill /IM Zalo.exe /F`) rồi mở lại kèm
     `--remote-debugging-port=9222`. Zalo Desktop là app single-instance
     (Electron `requestSingleInstanceLock`) nên mở thêm 1 lần nữa trong khi
     đang chạy sẽ không có tác dụng — bắt buộc phải tắt rồi mở lại mới gắn
     được cờ. **Phiên đăng nhập không mất** vì nó nằm trong profile cục bộ
     của app, không phải trong tiến trình.
   - Nếu **đã mở sẵn** (VD bot vừa chạy xong lần trước): bỏ qua, dùng luôn.
2. Kết nối tới cửa sổ chính của Zalo Desktop qua CDP
   (`connectToZaloMainPage`), có retry ~20s vì ngay sau khi mở lại app,
   cửa sổ cần vài giây để load xong `index.html`.
3. Chờ sidebar (danh sách hội thoại) render xong (`waitForSidebarLoaded`).
4. Với mỗi tên hội thoại trong `config.targets`:
   - Tìm đúng mục sidebar theo tên hiển thị, click mở.
   - Cuộn vùng tin nhắn lên đầu lặp lại để tải thêm lịch sử cũ hơn, dừng khi:
     tới giới hạn `config.targetMessageCount`, hoặc chiều cao vùng cuộn
     không đổi 3 lần liên tiếp (hết lịch sử để tải), hoặc mọi tin đang thấy
     đều cũ hơn `config.sinceTs` (không cần cuộn tiếp).
   - Lọc lại theo cả `sinceTs` (chặn dưới) và `untilTs` (chặn trên).
   - Ghi vào `MessageStore` (JSONL, dedupe theo `msgId`) **và** xuất một
     file JSON riêng cho lần chạy này.

## Cấu trúc thư mục — nơi cần biết/tương tác

```
config.ts                   ← SỬA Ở ĐÂY để đổi khung giờ, nhóm cần lấy, v.v.
index.ts                    ← chế độ 1: chạy 1 lần theo lịch cố định (`npm run bot:scrape`)
watch.ts                    ← chế độ 2: chạy liên tục, phản ứng theo thông báo (`npm run bot:watch`)
history/
  desktopScraper.ts         ← logic chính: ensureZaloReady, cuộn, cào, observer trong nhóm
  watch.ts                  ← logic watcher: observer thông báo + debounce + queue
  cdp.ts                    ← client CDP thô (WebSocket) thay Playwright
  scrapeSelectors.ts        ← CSS selector DOM Zalo Desktop (xem ghi chú bên dưới)
  exportJson.ts             ← xuất data/export/<thread>_<ngày>.json
store/
  messageStore.ts           ← ghi/đọc data/<thread>.jsonl, dedupe
mcp/
  server.ts                 ← MCP server chỉ-đọc, phơi data/ ra cho Claude
                               qua 3 tool: list_threads, get_recent_messages,
                               search_messages (chạy: `npm run mcp`)

data/                        ← DỮ LIỆU ĐẦU RA (không commit, .gitignore)
  <thread-slug>.jsonl        ← lưu vĩnh viễn, append-only, dedupe theo msgId
  export/
    <thread-slug>_<YYYY-MM-DD>.json   ← xuất theo từng lần chạy trong ngày,
                                         chạy lại trong cùng ngày sẽ ghi đè
```

Không còn các file `credentials.json`, `browser-session.json`, `qr.png`
trong repo root nữa — đó là tàn dư của hướng web/Playwright cũ, không còn được
code nào dùng, có thể xoá tay nếu muốn dọn.

## Cấu hình (`config.ts`)

| Trường | Ý nghĩa |
|---|---|
| `cdpPort` / `cdpUrl` | Cổng debug CDP dùng để mở/kết nối Zalo Desktop (mặc định `9222`). |
| `zaloExePath` | Đường dẫn `Zalo.exe`, **tự dò** trong `%LOCALAPPDATA%\Programs\Zalo\Zalo-*\Zalo.exe` (lấy bản mới nhất). Chỉ cần set tay nếu tự dò thất bại. |
| `autoLaunchZalo` | `true` = tự tắt/mở lại Zalo Desktop kèm cờ debug khi cần (bắt buộc `true` để chạy không người trực lúc lên lịch). |
| `dataDir` | Thư mục gốc chứa `data/` (JSONL + export). |
| `targets` | Danh sách **tên hiển thị chính xác** của hội thoại/nhóm cần lấy, đúng như hiện trên sidebar Zalo Desktop. |
| `sinceTs` | Mốc thời gian **chặn dưới** (unix ms). Dùng `todayAt(giờ, phút)` — tự tính theo **ngày hiện tại lúc bot chạy** (không phải ngày cố định), vì `todayAt` gọi `new Date()` mỗi lần `config.ts` được import. `null` = không chặn dưới. |
| `untilTs` | Mốc thời gian **chặn trên** (unix ms). Chỉ lọc kết quả cuối, không ảnh hưởng việc cuộn. `null` = không chặn trên (lấy tới lúc chạy thật sự). Dùng để cố định khung giờ (VD 8h–12h) không bị trôi nếu job chạy trễ. |
| `targetMessageCount` | Giới hạn an toàn số tin tối đa lấy mỗi nhóm mỗi lần chạy. |
| `scrollDelayMs` | Khoảng random (ms) giữa các lần cuộn, tránh cuộn dồn dập. |

**Ví dụ khung giờ:**
- 8h–12h cố định: `sinceTs: todayAt(8, 0)`, `untilTs: todayAt(12, 0)`.
- 6h sáng tới lúc chạy (không giới hạn trên): `sinceTs: todayAt(6, 0)`, `untilTs: null`.

## Cách chạy

```bash
npx tsx index.ts        # hoặc: npm run bot:scrape
```

Không cần đăng nhập gì thủ công (miễn Zalo Desktop trên máy đã đăng nhập
tài khoản cần lấy dữ liệu theo cách dùng bình thường).

Để đọc dữ liệu qua Claude Code/Claude Desktop:

```bash
npm run mcp                 # chạy mcp/server.ts qua stdio
```

## Dữ liệu đầu ra

### 1. `data/<thread-slug>.jsonl` — kho lưu vĩnh viễn

Mỗi dòng 1 tin nhắn (JSON), append-only, dedupe theo `msgId` (chạy lại
không tạo tin trùng). Mỗi dòng có shape `NormalizedMessage`
(`store/messageStore.ts`):

```ts
{
  msgId: string;        // id gốc từ Zalo Desktop, hoặc hash nếu không có
  threadId: string;      // slug của tên nhóm, VD "phucdaden"
  threadType: "group" | "user";
  senderId: string;      // luôn "" — Zalo Desktop không lộ id, chỉ có tên
  senderName: string;    // rỗng nếu là tin của chính tài khoản (isSelf)
  isSelf: boolean;
  ts: number;             // unix ms
  msgType: string;        // "desktop.text"
  content: unknown;       // nội dung text
  source: "history";
}
```

### 2. `data/export/<thread-slug>_<YYYY-MM-DD>.json` — xuất theo lần chạy

Mảng JSON, pretty-print, sắp theo thời gian tăng dần, chỉ chứa các tin của
**lần chạy đó** (đã áp `sinceTs`/`untilTs`). Giống `NormalizedMessage`
nhưng thêm 2 trường thời gian dễ đọc:

```json
{
  "msgId": "bb_msg_id_1789697377828",
  "threadId": "phucdaden",
  "threadType": "group",
  "senderId": "",
  "senderName": "",
  "isSelf": true,
  "ts": 1789697377828,
  "msgType": "desktop.text",
  "content": "/-strong",
  "source": "history",
  "timeIso": "2026-09-18T02:09:37.828Z",
  "timeLocal": "09:09:37 18/09/2026"
}
```

- `timeIso`: ISO 8601 UTC.
- `timeLocal`: giờ Việt Nam (`Asia/Ho_Chi_Minh`), định dạng `HH:mm:ss DD/MM/YYYY`.

Chạy lại trong cùng ngày sẽ **ghi đè** file export của ngày đó (không cộng
dồn) — file JSONL ở trên mới là nơi lưu lâu dài/dedupe.

## Chế độ 2: `watch.ts` — phản ứng theo thông báo (real-time)

Thay vì chạy 1 lần rồi thoát, `npm run bot:watch` đứng chạy liên tục và
phản ứng ngay khi có tin mới, thay vì đợi tới giờ quét kế tiếp. Dùng **2
observer** khác nhau (`history/watch.ts`):

1. **Observer thông báo (toast)** — gắn CDP vào cửa sổ popup thông báo
   riêng của Zalo Desktop (`znotification.html`, luôn hiển thị `#zname`/
   `#zbody` của thông báo gần nhất). Theo dõi bằng `MutationObserver`, mỗi
   khi đổi nội dung sẽ push sự kiện về Node qua CDP binding
   (`Runtime.addBinding` + `Runtime.bindingCalled`) — không polling. Tên
   nhóm trong thông báo có dạng `"Nhóm: <tên>"`; chỉ những tên khớp
   `config.targets` mới kích hoạt (nhóm khác/DM bị bỏ qua).
   - Có **debounce 2 giây** (gộp nhiều thông báo dồn dập của cùng 1 nhóm
     thành 1 lần quét) — nhưng nếu tin cứ liên tục không ngừng, lần quét
     thật sự có thể **bị trì hoãn vô hạn** (chưa có mốc "chờ tối đa" ép
     quét — cần biết trước, có thể thêm nếu cần).
2. **Observer trong nhóm đang mở** — sau khi observer #1 kích hoạt (click
   mở đúng nhóm, đọc dữ liệu hiện có), gắn thêm 1 `MutationObserver` **thẳng
   vào khung tin nhắn** của nhóm đó (`installLiveMessageObserver`), bắt
   từng `.chat-message` mới render ra DOM **ngay lập tức**, không cần đợi
   observer #1 nữa. Lý do cần cái này: khi 1 nhóm đang mở/focus, Zalo
   thường **không popup thông báo cho chính nhóm đó nữa** — nếu chỉ dựa vào
   observer #1, bot sẽ tự "điếc" với nhóm nó vừa mở ra đọc. Observer #2 giải
   quyết đúng lỗ hổng này. (Giả định: nhóm KHÁC vẫn nhảy toast bình thường,
   chỉ nhóm đang mở mới bị im — hợp lý theo UX chuẩn của app chat, đã quan
   sát được qua test thực tế nhưng chưa kiểm chứng đầy đủ mọi trường hợp.)

Dữ liệu quét theo observer nào cũng chỉ ghi vào `data/<thread>.jsonl`
(dedupe theo `msgId`) — **không đụng tới `data/export/...json`**, vì đó là
snapshot đầy đủ của cả ngày do chế độ 1 (`index.ts`) tạo ra; nếu watch mode
ghi đè bằng vài dòng vừa thấy sẽ làm mất dữ liệu các lần quét trước đó
trong ngày.

**Không chạy đồng thời `bot:scrape` (qua Task Scheduler) và `bot:watch`** —
cả hai đều gọi `ensureZaloReady()`, có thể tắt/mở lại Zalo Desktop nếu thấy
debug port chưa mở; nếu `bot:scrape` làm vậy giữa lúc `bot:watch` đang chạy,
toàn bộ kết nối CDP của watcher sẽ bị đứt theo. Chọn 1 trong 2 chế độ vận
hành, không dùng cả hai cùng lúc trên cùng 1 máy.

Watcher hiện chỉ là 1 tiến trình Node bình thường — **đóng terminal là nó
tắt theo**, không tự phục hồi khi crash hay khi máy khởi động lại. Muốn
chạy thật sự "nền" kiểu service thì cần thêm lớp quản lý tiến trình (pm2,
Windows Service qua NSSM, hoặc Task Scheduler với trigger "khi khởi động
máy") — chưa được thiết lập.

## Đầu vào duy nhất cần chỉnh tay

Không có input file nào cần chuẩn bị — đầu vào duy nhất là
**`config.targets`** (tên nhóm) và khung giờ `sinceTs`/`untilTs` trong
`config.ts`. Mọi thứ còn lại (đăng nhập, mở app, tìm nhóm, cuộn, ghi
file) đều tự động.

## Selector DOM (`history/scrapeSelectors.ts`)

Các class CSS này đã xác nhận **trực tiếp trên một bản Zalo Desktop thật**
qua CDP probe (không phải đoán). Nếu Zalo Desktop update giao diện và bot
báo không tìm thấy nhóm/tin nhắn, đây là chỗ đầu tiên cần kiểm tra lại
(mở DevTools tương đương — tức là chạy lại 1 probe CDP thủ công để soi DOM
mới) và cập nhật selector cho khớp.

## Bảo trì — những điểm dễ vỡ cần chú ý

Xếp theo khả năng gặp phải, cao → thấp:

1. **Selector DOM (`history/scrapeSelectors.ts`)** — điểm dễ vỡ nhất.
   Gắn chặt vào bản UI hiện tại của Zalo Desktop; mỗi lần Zalo tự động
   update giao diện, các class này có thể đổi và scraper sẽ âm thầm trả về
   rỗng hoặc báo `"sidebar item for ... not found"`. Dấu hiệu: số tin scan
   được tụt về 0 dù nhóm vẫn có tin mới. Cách sửa: chạy lại một probe CDP
   thủ công (mở port debug, `Runtime.evaluate` để soi DOM mới — xem lại
   cách làm ở phần lịch sử spike ban đầu) rồi cập nhật lại selector.

2. **`config.targets` không tự theo kịp việc đổi tên nhóm** — đổi tên nhóm
   trong Zalo thì phải tự sửa `targets` cho khớp tên mới, **và** lịch sử sẽ
   tách thành file `.jsonl` mới (theo slug của tên mới), file cũ đóng băng
   lại. Không có cơ chế nối lịch sử tự động qua lần đổi tên.

3. **Định dạng `msgId`/timestamp có thể thay đổi theo loại tin nhắn** — đã
   từng gặp: tin nhắn dạng album ảnh có id `bb_msg_id_<ts>_<n>_<groupId>`
   khác với tin text thường (`bb_msg_id_<ts>`), khiến parse timestamp sai
   và tin bị "trôi" lên thành mới nhất một cách giả. Đã vá bằng cách chỉ
   lấy số ở đoạn đầu id, nhưng các loại tin khác (sticker, file, voice,
   tin nhắn bị thu hồi...) chưa được test kỹ — nếu thấy `content: ""` hoặc
   `timeLocal` bất thường trong file export, khả năng cao là một định dạng
   id mới chưa được xử lý.

4. **`zaloExePath` tự dò theo cấu trúc thư mục cài đặt hiện tại**
   (`%LOCALAPPDATA%\Programs\Zalo\Zalo-<version>\Zalo.exe`). Nếu Zalo đổi
   cách cài đặt (VD chuyển sang Microsoft Store/MSIX) thì auto-detect sẽ
   thất bại — lúc đó cần set `zaloExePath` thủ công trong `config.ts`.

5. **`autoLaunchZalo: true` sẽ tắt Zalo Desktop bất kể bạn đang dùng dở** —
   nếu job chạy đúng lúc bạn đang gõ chat mà debug port chưa mở, Zalo sẽ bị
   tắt/mở lại đột ngột (không mất dữ liệu, chỉ gián đoạn UI). Nếu thấy
   phiền, có thể tắt `autoLaunchZalo` và tự đảm bảo Zalo luôn mở kèm
   `--remote-debugging-port=9222` (VD gắn cờ vào shortcut).

6. **Không có cơ chế bù lại (backfill) nếu job bị bỏ lỡ** — máy tắt/ngủ
   đúng giờ lên lịch, hoặc Task Scheduler bị lỗi, thì ngày đó coi như mất,
   `sinceTs`/`untilTs` không tự lùi lại quét bù.

7. **Không có cảnh báo khi chạy lỗi** — script chỉ log ra console và thoát
   mã lỗi khác 0; nếu chạy qua Task Scheduler không ai để ý, lỗi sẽ không
   ai biết trừ khi chủ động kiểm tra lịch sử tác vụ hoặc log.

8. **`data/` không có dọn dẹp tự động** — `data/*.jsonl` tăng dần vô hạn
   (append-only), `data/export/` cộng thêm 1 file/nhóm/ngày mỗi ngày chạy.
   Không ảnh hưởng chức năng nhưng nên để ý dung lượng nếu chạy lâu dài.

## Lên lịch chạy tự động

Chưa cấu hình Task Scheduler — hiện phải chạy tay `npx tsx index.ts`.
Khi cần chạy tự động (VD 12:00 hằng ngày), tạo một Scheduled Task Windows
gọi đúng lệnh đó trong thư mục repo; `autoLaunchZalo: true` đảm bảo Zalo
Desktop sẽ tự khởi động lại kèm cổng debug kể cả khi máy chưa mở Zalo hoặc
Zalo đang mở không kèm cờ debug.
