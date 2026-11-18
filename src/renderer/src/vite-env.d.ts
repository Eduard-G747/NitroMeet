/// <reference types="vite/client" />

declare module '*.ts?raw' {
  const src: string
  export default src
}
