import { defineConfig } from "vite";

export default defineConfig({
  // 我们按文件路径往 jsnes 内部的 mapper 表里注册 mapper 74/194，
  // 预打包会生成另一份 jsnes 副本，注册就失效了
  optimizeDeps: { exclude: ["jsnes"] },
});
