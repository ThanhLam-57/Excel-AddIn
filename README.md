# Cài đặt MySQL trên Windows

## Tải bản ZIP và giải nén:
https://dev.mysql.com/downloads/mysql/

## Khởi tạo dữ liệu:
```
mysqld --initialize --user=root --console
```
Chú ý copy lại mật khẩu của tài khoản root trên console.

## Chạy thử server:
```
mysqld
```

## Tạo service của Windows:
```
mysqld --install MySQL
```
Vào Control Panel > Services rồi chuyển service cho tự động chạy.

## Login vào tài khoản root rồi đổi mật khẩu:
```
ALTER USER 'root'@'localhost' IDENTIFIED WITH mysql_native_password BY 'root-password';
```

## Tạo CSDL mới, tài khoản mới và gán quyền:
```
CREATE USER 'klmo'@'localhost' IDENTIFIED WITH mysql_native_password BY 'klmo';
CREATE DATABASE klmo;
GRANT ALL ON klmo.* TO 'klmo'@'localhost';
```

# Chạy project

## Khởi tạo
```
cd server
npm install
```

## Client-side CSS & JS watch
```
npm run js-css
```

## Run server
```
npm run dev
```