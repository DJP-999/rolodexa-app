/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  serverExternalPackages: ["postgres", "bullmq", "ioredis"],
  // PitchBook/CSV uploads can be large (multi-MB XLSX). Default server-action body
  // limit is 1MB, which silently rejects big imports — raise it.
  experimental: { serverActions: { bodySizeLimit: "25mb" } },
  eslint: { ignoreDuringBuilds: true },
  // Codebase is type-clean (verified via `npm run typecheck`), so let the build
  // catch type regressions instead of shipping them silently.
  typescript: { ignoreBuildErrors: false },
};

export default nextConfig;
