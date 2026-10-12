# Orca Deck

Bảng 8 nút đặt cạnh Mac mini. iPad mini 3 / iOS 12.5.8 mở bằng Safari, không cần cài app. Chạy trên Mac, cùng mạng Wi‑Fi với iPad.

## Mở bảng nút

1. Bấm đúp `Start.command` trên Mac và để cửa sổ đó mở. Nếu bản hiện tại đã chạy thì không mở thêm.
2. Nhập địa chỉ “Trên iPad” được in trong cửa sổ đó vào Safari trên iPad. Địa chỉ có thể đổi khi Mac đổi mạng.
3. Nhập mã ghép nối 8 chữ số. Mã chỉ có trong cửa sổ Mac; API không cung cấp mã đó.
4. Bấm **Chọn agent**. Bấm **Claude chính** cạnh phiên Claude dùng để orchestrate để ghim nó. Từ đó nút Claude chính đưa đúng phiên ấy lên Mac.
5. Bấm **Đặt liên kết** để lưu PR và preview theo project. Các nút mở liên kết trên Mac, kể cả `http://localhost:3000`.

Có thể dùng Safari → Chia sẻ → Thêm vào Màn hình chính. Đặt iPad nằm ngang để có hai hàng, mỗi hàng bốn nút. Tắt tự khóa nếu muốn để bảng luôn hiện.

## Duyệt Claude

Hook `PermissionRequest` gửi từng yêu cầu đến bảng. Chọn yêu cầu trong danh sách; đọc project, mã phiên và nội dung trước khi bấm **Approve once** hoặc **Reject**. Duyệt một lần, không tạo quyền “luôn cho phép”. Việc chọn terminal và chọn yêu cầu là hai lựa chọn được ghi nhãn riêng; không đoán phiên từ tên project vì một project có thể có nhiều Claude.

Khi không mở bảng, dịch vụ không chạy, hoặc yêu cầu quá 3 phút, hook trả về luồng duyệt bình thường của Claude. Yêu cầu cũ không thể được duyệt lại. Yêu cầu chỉ ở trong bộ nhớ, không lưu transcript hay lệnh vào file.

Hook đã có script cài đặt, giữ nguyên mọi hook/quyền hiện có và sao lưu trước thay đổi:

```sh
/usr/bin/python3 install-hook.py
```

Claude Code mới thường tự nhận thay đổi cấu hình. Nếu một phiên cũ chưa hiện yêu cầu, thử mở `/hooks` kiểm tra hook; chỉ mở lại/resume phiên khi thuận tiện, không ngắt công việc đang chạy.

Để gỡ, bấm đúp `Gỡ-hook.command`. Script chỉ gỡ hook Orca Deck, giữ nguyên các hook khác.

## Các nút khác

- **Continue:** gửi chữ `continue` và Enter đến agent đang chọn khi terminal ở trạng thái chờ. Tránh bấm khi đang thao tác menu; nhận input không đồng nghĩa agent đã bắt đầu lượt mới.
- **Interrupt:** gửi ngắt qua Orca đến agent đang chọn.
- **Chọn agent / Claude chính:** đưa terminal lên màn hình Mac; mã phiên được kiểm tra lại để tránh gửi sang tiến trình đã thay thế.
- **Mở PR / Mở preview:** chỉ nhận HTTP/HTTPS và mở bằng trình duyệt mặc định của Mac.

## Giới hạn bản đầu

- Claude Code nhận Approve/Reject qua hook. Codex có chuyển terminal, Continue và Interrupt; duyệt Codex vẫn trên Mac.
- Hộp duyệt mạng của sandbox Claude và một số hộp hỏi đặc biệt vẫn xử lý trên Mac.
- Giao diện dùng JavaScript ES5, XMLHttpRequest và CSS hỗ trợ Safari iOS 12; cần thử thực tế trên iPad để xác nhận trải nghiệm.
- Dùng trong mạng nội bộ tin cậy. HTTP không mã hóa; không mở cổng này ra Internet. Có mã ghép nối, token riêng cho hook, kiểm tra nguồn request và chống thử mã liên tục.
- `.local/` chứa mã ghép nối và token riêng của máy. Không chia sẻ thư mục này. Đóng cửa sổ dịch vụ sẽ dừng bảng; không tự chạy lúc đăng nhập.

## Kiểm thử

```sh
npm test
```

Không cần cài package. Tài liệu Claude: https://code.claude.com/docs/en/hooks#permissionrequest
