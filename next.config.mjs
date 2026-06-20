/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  serverExternalPackages: ["postgres", "bullmq", "ioredis"],
  eslint: { ignoreDuringBuilds: true },
  // Codebase is type-clean (verified via `npm run typecheck`), so let the build
  // catch type regressions instead of shipping them silently.
  typescript: { ignoreBuildErrors: false },
};

export default nextConfig;
