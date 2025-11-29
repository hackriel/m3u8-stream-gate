import React, { Suspense, lazy } from "react";

const EmisorM3U8Panel = lazy(() => import("../components/EmisorM3U8Panel"));

const Index = () => {
  return (
    <Suspense fallback={<div>Cargando panel de emisión...</div>}>
      <EmisorM3U8Panel />
    </Suspense>
  );
};

export default Index;
