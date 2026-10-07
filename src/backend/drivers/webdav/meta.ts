export const config = {
  name: "WebDav",
  localSort: true,
  defaultRoot: "/",
  // 對齊 Go drivers/webdav/meta.go 的 PreferProxy: true。
  // WebDAV 直鏈帶認證信息，直接 302 給瀏覽器會丟認證，因此默認走服務端代理。
  // 驅動能力表的唯一真相在 internal/driver/proxy.ts，此處不再重複登記。
  preferProxy: true,
}
