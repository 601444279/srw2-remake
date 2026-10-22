import { defineConfig } from "vite";

export default defineConfig({
  // 我们按文件路径往 jsnes 内部的 mapper 表里注册 mapper 74/194，
  // 预打包会生成另一份 jsnes 副本，注册就失效了
  optimizeDeps: { exclude: ["jsnes"] },
  // 存档和设置按网址（含端口）分开保存：只用 5174 这一个端口，固定死，被占用就报错而不是换端口
  server: { port: 5174, strictPort: true },
  build: {
    rollupOptions: {
      input: { remake: "index.html", emulator: "emu.html" },
    },
  },
});
