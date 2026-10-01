# simple-restapi
@hungdentutuonglai

REST API chạy trên Cloudflare Workers, dữ liệu lưu ở D1 (SQLite).

CRUD cho tài nguyên `users`. Đọc thì công khai, ghi thì cần Bearer token.

---

## Mục lục

- [Yêu cầu](#yêu-cầu)
- [Cài đặt](#cài-đặt)
- [Chạy local](#chạy-local)
- [Deploy lên production](#deploy-lên-production)
- [Danh sách endpoint](#danh-sách-endpoint)
- [Định dạng phản hồi](#định-dạng-phản-hồi)
- [Quy tắc validate](#quy-tắc-validate)
- [Mã lỗi HTTP](#mã-lỗi-http)
- [Xác thực](#xác-thực)
- [Cấu hình](#cấu-hình)
- [Cấu trúc file](#cấu-trúc-file)
- [Xử lý sự cố](#xử-lý-sự-cố)
- [Những điều cần biết về Worker](#những-điều-cần-biết-về-worker)
- [Chưa có trong bản này](#chưa-có-trong-bản-này)

---

## Yêu cầu

| Thành phần | Phiên bản | Ghi chú |
|---|---|---|
| Node.js | 18 trở lên | chỉ để chạy wrangler, không phải runtime của API |
| npm | 9 trở lên | |
| Tài khoản Cloudflare | — | chỉ cần khi deploy, chạy local thì không |

Chạy local không cần tài khoản Cloudflare và không tốn tiền. Wrangler mở `workerd` —
chính runtime dùng trên production — nên môi trường local sát với thật.

---

## Cài đặt

```bash
cd api-worker
npm install
```

Lệnh này tải `wrangler` và `workerd` (khoảng 80 MB binary cho nền tảng của bạn).

Tiếp theo, tạo file biến môi trường cho local:

```bash
# Windows
copy .dev.vars.example .dev.vars

# macOS / Linux
cp .dev.vars.example .dev.vars
```

Mở `.dev.vars` và đổi `API_KEY` thành một chuỗi ngẫu nhiên. Giá trị này chỉ dùng
khi chạy local. File `.dev.vars` đã nằm trong `.gitignore` nên không bị commit.

Cuối cùng, nạp schema vào D1 local:

```bash
npm run db:local
```

Lệnh này tạo bảng `users` và chèn 3 bản ghi mẫu. Chạy lại sẽ **xoá sạch bảng và
tạo lại** (vì `schema.sql` có `DROP TABLE IF EXISTS`), nên đừng chạy khi đã có
dữ liệu cần giữ.

---

## Chạy local

```bash
npm run dev
```

Server lên ở `http://127.0.0.1:8787`. Wrangler tự reload khi bạn sửa file trong `src/`.

Thử ngay:

```bash
curl http://127.0.0.1:8787/health
```

```json
{
  "status": "ok",
  "checks": { "worker": "ok", "database": "ok" },
  "time": "2026-10-01T01:46:10.425Z"
}
```

Nếu `checks.database` trả `"not_bound"` hoặc `"error"`, xem phần
[Xử lý sự cố](#xử-lý-sự-cố).

### Xem log

Khi `npm run dev` đang chạy, mọi `console.error` trong code hiện ngay ở terminal đó.
Với Worker đã deploy, dùng:

```bash
npm run tail
```

---

## Deploy lên production

Bốn bước, theo đúng thứ tự.

### 1. Tạo D1 database

```bash
npx wrangler d1 create api-worker-db
```

Lệnh in ra một khối như sau:

```toml
[[d1_databases]]
binding = "DB"
database_name = "api-worker-db"
database_id = "a1b2c3d4-...."
```

Chép `database_id` đó vào `wrangler.toml`, thay cho `REPLACE_WITH_YOUR_DATABASE_ID`.

### 2. Nạp schema lên D1 thật

```bash
npm run db:remote
```

Lưu ý: lệnh này cũng có `DROP TABLE` nên chỉ chạy một lần lúc khởi tạo. Về sau
muốn đổi schema thì viết file migration riêng, đừng chạy lại `schema.sql`.

### 3. Đặt API key

```bash
npx wrangler secret put API_KEY
```

Wrangler sẽ hỏi giá trị. Dán vào một chuỗi ngẫu nhiên dài. Sinh chuỗi:

```bash
# Windows PowerShell
[Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Max 256 }))

# macOS / Linux
openssl rand -base64 32
```

Secret được lưu mã hoá ở Cloudflare, không nằm trong code và không vào git.

### 4. Deploy

```bash
npm run deploy
```

Wrangler in ra URL dạng `https://rest-api-worker.<tên-tài-khoản>.workers.dev`.

### Trước khi mở cho người thật dùng

Hai chỗ trong `wrangler.toml` cần xem lại:

- **`database_id`** — còn là `REPLACE_WITH_YOUR_DATABASE_ID` thì mọi endpoint
  `/users` trả 503.
- **`ALLOWED_ORIGIN`** — mặc định `"*"`, nghĩa là **bất kỳ trang web nào** cũng
  gọi được API này từ trình duyệt của khách. Đổi thành domain thật, ví dụ
  `"https://app.example.com"`.

---

## Danh sách endpoint

| Method | Path | Auth | Mô tả |
|---|---|---|---|
| `GET` | `/` | — | Danh sách endpoint |
| `GET` | `/health` | — | Kiểm tra worker và kết nối D1 |
| `GET` | `/users` | — | Danh sách users, có phân trang |
| `GET` | `/users/:id` | — | Một user theo id |
| `POST` | `/users` | Bearer | Tạo user mới |
| `PUT` | `/users/:id` | Bearer | Cập nhật user (partial) |
| `DELETE` | `/users/:id` | Bearer | Xoá user |

### GET /users

Tham số query:

| Tham số | Mặc định | Giới hạn | Ghi chú |
|---|---|---|---|
| `limit` | 20 | 1–100 | giá trị ngoài khoảng bị kẹp về biên |
| `offset` | 0 | 0–1000000 | |

Giá trị không phải số nguyên bị bỏ qua, dùng mặc định thay vì báo lỗi.

```bash
curl "http://127.0.0.1:8787/users?limit=2&offset=0"
```

```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "name": "Nguyễn Văn A",
      "email": "a@example.com",
      "age": 30,
      "created_at": "2026-10-01 01:41:58"
    },
    {
      "id": 2,
      "name": "Trần Thị B",
      "email": "b@example.com",
      "age": 25,
      "created_at": "2026-10-01 01:41:58"
    }
  ],
  "meta": { "total": 3, "limit": 2, "offset": 0 }
}
```

### GET /users/:id

```bash
curl http://127.0.0.1:8787/users/1
```

### POST /users

Trả `201` kèm header `Location: /users/<id>`.

```bash
curl -X POST http://127.0.0.1:8787/users \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{"name":"Hoàng Văn D","email":"d@example.com","age":28}'
```

`name` được trim, `email` được trim và chuyển thành chữ thường. Gửi
`"  Hoàng Văn D  "` và `"D@Example.COM"` thì lưu vào DB là `"Hoàng Văn D"` và
`"d@example.com"`.

### PUT /users/:id

Cập nhật **partial**: chỉ những trường có mặt trong body bị thay đổi.

```bash
# Chỉ đổi age, name và email giữ nguyên
curl -X PUT http://127.0.0.1:8787/users/2 \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{"age":41}'
```

Gửi `{"age": null}` để xoá giá trị `age` đang có.

Body không chứa trường nào trong `name`/`email`/`age` thì trả `422` — tránh
trường hợp gõ sai tên trường rồi tưởng đã cập nhật thành công.

### DELETE /users/:id

Trả về bản ghi vừa xoá, để bạn còn dữ liệu mà log hoặc hoàn tác.

```bash
curl -X DELETE http://127.0.0.1:8787/users/4 \
  -H "Authorization: Bearer $API_KEY"
```

---

## Định dạng phản hồi

Mọi phản hồi là JSON với `Content-Type: application/json; charset=utf-8`.

**Thành công:**

```json
{
  "success": true,
  "data": { }
}
```

`GET /users` có thêm `meta` chứa thông tin phân trang.

**Lỗi:**

```json
{
  "success": false,
  "error": {
    "message": "Dữ liệu không hợp lệ",
    "details": ["email: định dạng không hợp lệ", "age: phải là số nguyên từ 0 đến 150"]
  }
}
```

`details` chỉ xuất hiện khi có lỗi validate chi tiết. Lỗi validate trả về **toàn
bộ** vấn đề trong một lần, không phải từng lỗi một.

---

## Quy tắc validate

| Trường | Bắt buộc khi POST | Kiểu | Ràng buộc |
|---|---|---|---|
| `name` | có | string | không rỗng sau khi trim, tối đa 120 ký tự |
| `email` | có | string | đúng định dạng email, tối đa 254 ký tự, **duy nhất** |
| `age` | không | integer hoặc null | 0–150 |

Với `PUT`, mọi trường đều không bắt buộc, nhưng phải có ít nhất một.

Tính duy nhất của `email` được chặn bằng `UNIQUE` ở tầng database, không chỉ ở
code. Lý do: hai request đến cùng lúc với cùng một email thì kiểm tra trong code
không chặn được — cả hai đều thấy "chưa tồn tại" rồi cả hai đều ghi. Ràng buộc
của SQLite mới là chốt cuối, và API chuyển lỗi đó thành `409`.

---

## Mã lỗi HTTP

| Mã | Khi nào |
|---|---|
| `200` | GET, PUT, DELETE thành công |
| `201` | POST tạo mới thành công, kèm header `Location` |
| `204` | OPTIONS preflight |
| `400` | `id` không phải số nguyên dương; body không phải JSON; thiếu `Content-Type: application/json` |
| `401` | Thiếu hoặc sai Bearer token |
| `404` | Không tìm thấy bản ghi, hoặc endpoint không tồn tại |
| `405` | Đường dẫn đúng nhưng method không hỗ trợ (ví dụ `PATCH /users/1`) |
| `409` | Email đã tồn tại |
| `422` | Dữ liệu sai định dạng hoặc thiếu trường bắt buộc |
| `500` | Lỗi không lường trước. Chi tiết chỉ vào log, không trả về client |
| `503` | Chưa gắn D1 database, hoặc chưa cấu hình `API_KEY` |

Phân biệt `400` và `422`: `400` là body không đọc được (không phải JSON, sai
header). `422` là body đọc được nhưng nội dung không hợp lệ.

---

## Xác thực

`GET` công khai. `POST`, `PUT`, `DELETE` cần header:

```
Authorization: Bearer <API_KEY>
```

Ba điểm trong thiết kế đáng nói rõ:

**Fail-closed.** Chưa cấu hình `API_KEY` thì mọi thao tác ghi trả `503`, không
phải mở cửa cho tất cả. Deploy mà quên `wrangler secret put` thì API tự khoá lại.

**So sánh constant-time.** Dùng `===` để so token sẽ thoát ngay ở ký tự đầu khác
nhau. Chênh lệch thời gian phản hồi đó đủ để dò token từng ký tự. Hàm
`constantTimeEqual` XOR toàn bộ byte rồi mới trả kết quả.

**Đọc công khai là lựa chọn mặc định, không phải điều hiển nhiên đúng.** Nếu dữ
liệu của bạn không nên ai cũng xem được, sửa `authorize()` trong `src/index.js`
để kiểm tra token cho mọi method.

---

## Cấu hình

### Biến trong `wrangler.toml`

| Tên | Mặc định | Ý nghĩa |
|---|---|---|
| `ALLOWED_ORIGIN` | `"*"` | Giá trị cho header `Access-Control-Allow-Origin` |

### Secret

| Tên | Cách đặt |
|---|---|
| `API_KEY` | Local: file `.dev.vars`. Production: `wrangler secret put API_KEY` |

**Đừng đặt `API_KEY` vào `[vars]` trong `wrangler.toml`** — file đó được commit
vào git, secret sẽ lộ trong lịch sử repo.

### Binding

| Binding | Loại | Dùng cho |
|---|---|---|
| `DB` | D1 Database | Toàn bộ dữ liệu `users` |

---

## Cấu trúc file

```
api-worker/
├── src/
│   └── index.js          # Toàn bộ API: router, handler, validate, auth
├── schema.sql            # Schema D1 + 3 bản ghi mẫu
├── wrangler.toml         # Cấu hình Worker, binding D1, biến môi trường
├── package.json          # Scripts và devDependency wrangler
├── .dev.vars.example     # Mẫu biến môi trường local
├── .dev.vars             # Biến thật cho local (KHÔNG commit)
├── .gitignore
└── README.md
```

### npm scripts

| Lệnh | Việc |
|---|---|
| `npm run dev` | Chạy local ở cổng 8787, tự reload |
| `npm run deploy` | Deploy lên Cloudflare |
| `npm run db:local` | Nạp `schema.sql` vào D1 local (xoá và tạo lại bảng) |
| `npm run db:remote` | Nạp `schema.sql` vào D1 production (xoá và tạo lại bảng) |
| `npm run tail` | Xem log realtime của Worker đã deploy |

---

## Xử lý sự cố

### `/health` trả `"database": "not_bound"`

`wrangler.toml` chưa có binding `DB`, hoặc `database_id` còn là
`REPLACE_WITH_YOUR_DATABASE_ID`. Chạy `npx wrangler d1 create api-worker-db` rồi
chép id vào.

### `/health` trả `"database": "error"`

Binding có nhưng query thất bại — thường là chưa nạp schema. Chạy
`npm run db:local` (hoặc `db:remote`).

### `no such table: users`

Chưa nạp schema vào đúng môi trường. Local và production là **hai database riêng
biệt**; nạp cho local không ảnh hưởng production và ngược lại.

### POST/PUT/DELETE trả 503 "API_KEY chưa được cấu hình"

Local: chưa có file `.dev.vars`, hoặc trong đó thiếu dòng `API_KEY`.
Production: chưa chạy `wrangler secret put API_KEY`.

Sau khi tạo `.dev.vars`, phải khởi động lại `npm run dev` — wrangler chỉ đọc file
đó lúc start.

### npm cảnh báo "packages have install scripts not yet covered by allowScripts"

npm 11 chặn install script theo mặc định. Thường vẫn không sao vì `workerd` tải
binary qua platform package riêng. Kiểm tra:

```bash
# Windows
dir node_modules\@cloudflare\workerd-windows-64\bin
```

Thấy `workerd.exe` khoảng 80 MB là ổn. Nếu thiếu, chạy
`npm install-scripts approve workerd` rồi `npm install` lại.

### Cổng 8787 đã bị dùng

```bash
npx wrangler dev --port 8788
```

### Trên Windows PowerShell: `curl` trả 400 với body hợp lệ

Hai cái bẫy riêng của PowerShell 5.1:

**`curl` là alias của `Invoke-WebRequest`**, không phải `curl.exe`. Cú pháp khác
hoàn toàn. Gọi rõ `curl.exe`:

```powershell
curl.exe -s http://127.0.0.1:8787/users
```

**Chuỗi JSON có dấu cách bị cắt** khi truyền qua `-d`. Cách chắc ăn nhất là đưa
body vào file:

```powershell
'{ "name": "Hoàng Văn D", "email": "d@example.com", "age": 28 }' | Out-File -Encoding utf8 body.json
curl.exe -s -X POST http://127.0.0.1:8787/users `
  -H "Content-Type: application/json" `
  -H "Authorization: Bearer $env:API_KEY" `
  --data-binary "@body.json"
```

Hoặc dùng `Invoke-RestMethod` thuần PowerShell:

```powershell
$body = @{ name = "Hoàng Văn D"; email = "d@example.com"; age = 28 } | ConvertTo-Json
Invoke-RestMethod -Method POST -Uri "http://127.0.0.1:8787/users" `
  -ContentType "application/json" `
  -Headers @{ Authorization = "Bearer $env:API_KEY" } `
  -Body $body
```

Lưu ý `Invoke-RestMethod` trên PowerShell 5.1 **ném exception** khi gặp mã lỗi
4xx/5xx thay vì trả về response. Tham số `-SkipHttpErrorCheck` chỉ có từ
PowerShell 7. Muốn xem nội dung lỗi thì bọc `try/catch`, hoặc dùng `curl.exe`.

---

## Những điều cần biết về Worker

**Không có state giữa các request.** Đây là khác biệt lớn nhất so với một server
Node thông thường. Viết thế này trên Worker là sai:

```js
let users = [];              // SAI: mất bất cứ lúc nào
app.post('/users', ...)      // và hai request có thể thấy hai giá trị khác nhau
```

Mỗi request có thể chạy trên một isolate khác, và isolate bị thu hồi bất cứ lúc
nào. Mọi dữ liệu cần tồn tại qua nhiều request phải nằm ở D1, KV, R2 hoặc Durable
Objects. Trong code này, biến toàn cục duy nhất là hằng số cấu hình — không có
cái nào giữ dữ liệu.

**Không phải Node.js.** Không có `fs`, `path`, `process.env` theo cách thường
dùng. Biến môi trường đến qua tham số `env` của `fetch()`. Express không chạy
được, nên router ở đây dùng `URLPattern` của Web Platform API.

**`RETURNING` tiết kiệm một lượt đi.** D1 hỗ trợ `INSERT ... RETURNING` và
`UPDATE ... RETURNING` của SQLite, nên tạo/sửa rồi lấy lại bản ghi chỉ cần một
query thay vì hai. Với Worker, mỗi lượt đi tới D1 đều tính vào thời gian phản
hồi nên điều này đáng làm.

**`batch()` gộp nhiều query.** `GET /users` cần cả trang dữ liệu và tổng số bản
ghi. Gọi `env.DB.batch([...])` đưa cả hai vào một lượt, rẻ hơn hai `await` riêng.

---

## Chưa có trong bản này

Những thứ một API production thường cần nhưng bản này chưa làm:

- **Rate limiting.** Endpoint công khai không giới hạn tần suất thì ai cũng quét
  được. Cloudflare có Rate Limiting Rules cấu hình ở dashboard, hoặc làm trong
  code bằng KV / Durable Objects.
- **Phân quyền theo người dùng.** Hiện chỉ có một `API_KEY` duy nhất, ai có key
  thì ghi được mọi bản ghi. Cần nhiều người dùng với quyền khác nhau thì phải
  thêm bảng `api_keys` hoặc dùng JWT.
- **Migration.** `schema.sql` có `DROP TABLE`, chỉ phù hợp lúc khởi tạo. Đổi
  schema khi đã có dữ liệu thật thì cần file migration tăng dần.
- **Test tự động.** Code đã được kiểm chứng bằng tay qua 20 trường hợp, nhưng
  chưa có test suite. Dùng `vitest` với `@cloudflare/vitest-pool-workers` để
  chạy test trong đúng runtime của Worker.
- **Phân trang theo cursor.** `limit`/`offset` đủ dùng cho dữ liệu nhỏ. Bảng lớn
  thì `OFFSET` chậm dần vì SQLite vẫn phải đếm qua các dòng bị bỏ.
