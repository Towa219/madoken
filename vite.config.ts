import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// 公開用に全アセットを1つのHTMLへインライン化する
export default defineConfig({
  plugins: [viteSingleFile()],
});
