# Tải và cài myscan Android

myscan quét tài liệu, chỉnh ảnh, sắp xếp trang và ghép PDF ngay trên điện thoại. Cần **Android 8.0 trở lên**.

**[Tải myscan Android 1.0.0 — APK thử nghiệm](https://github.com/nhhai-math/myscan/raw/refs/heads/main/downloads/myscan-android-1.0.0-debug.apk)**

Quét QR bằng camera hoặc Google Lens trên điện thoại để mở cùng liên kết tải:

[![Mã QR tải APK myscan Android](myscan-android-download-qr.png)](https://github.com/nhhai-math/myscan/raw/refs/heads/main/downloads/myscan-android-1.0.0-debug.apk)

Có thể tải [QR PNG](myscan-android-download-qr.png) hoặc [QR SVG](myscan-android-download-qr.svg) để in hoặc chia sẻ. Giữ nguyên khoảng trắng quanh mã khi sử dụng.

## Cài trên điện thoại

1. Mở liên kết tải hoặc quét mã QR. Nếu trình duyệt cảnh báo về tệp APK, kiểm tra tên tệp là `myscan-android-1.0.0-debug.apk` và địa chỉ thuộc repository `nhhai-math/myscan` trên GitHub rồi tải tệp.
2. Mở APK từ mục **Tệp đã tải xuống** của trình duyệt hoặc ứng dụng **Tệp**.
3. Nếu Android yêu cầu, vào **Cài đặt → Cho phép từ nguồn này** cho ứng dụng đang mở APK, quay lại và chọn **Cài đặt**. Tên mục có thể khác giữa các hãng điện thoại.
4. Mở **myscan**, tạo tài liệu, chọn **Quét bằng camera** và cấp quyền **Camera** khi được hỏi. Chụp, chọn **Dùng ảnh này**, chỉnh bốn góc và màu ảnh, rồi **Lưu trang**.
5. Thêm các trang tiếp theo, sắp xếp thứ tự và chọn **Xuất PDF → Lưu PDF** để lưu tài liệu hoàn thiện. Có thể **Chia sẻ PDF** qua ứng dụng trên điện thoại.

APK này được ký bằng khóa **debug** để cài thử; chưa phát hành trên Google Play. Nếu máy đang có bản myscan được ký bằng khóa khác, Android sẽ từ chối cập nhật. Hãy xuất các PDF cần giữ trước khi gỡ bản cũ, vì gỡ ứng dụng sẽ xóa thư viện trong ứng dụng.

Chỉ quá trình tải bộ cài cần Internet. Ứng dụng không khai báo quyền Internet; camera, chỉnh ảnh, thư viện và xuất PDF hoạt động **offline**, không cần máy tính hay tài khoản. Ứng dụng chỉ xin quyền **Camera**; chọn ảnh và lưu PDF dùng bộ chọn tệp Android.

## Thông tin bộ cài

| Mục | Giá trị |
| --- | --- |
| Phiên bản | 1.0.0, debug |
| Android tối thiểu | 8.0 / API 26 |
| Tên gói | `com.nhhai.myscan` |
| Dung lượng | 4.704.805 byte, khoảng 4,49 MiB |
| SHA-256 | `b73891195767d9a13518770d2105a65d870ffe671ebb65814562698634d6e243` |

Checksum cũng được lưu trong [downloads/SHA256SUMS](../downloads/SHA256SUMS). QR trỏ trực tiếp tới APK của phiên bản 1.0.0 trong nhánh `main` của repository này.

Đã chạy thành công **23 kiểm thử JVM** và **10 kiểm thử Android trên Android 15 / API 35**. Luồng chụp, chỉnh ảnh và lưu PDF đã được kiểm tra trên giả lập; chưa kiểm tra camera trên điện thoại vật lý.

Xem [mã nguồn và hướng dẫn build Android](../android/README.md) hoặc [luồng ứng dụng web](../README.md#bản-web-qua-qr).
