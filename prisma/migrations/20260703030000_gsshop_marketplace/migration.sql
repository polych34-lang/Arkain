-- ARK-46: add the `gsshop` value to the Marketplace enum so imported GS샵
-- orders (via the separate src/imports/gsshop excel-import pipeline, not a
-- MarketplaceAdapter) can be stored through the existing Order table.
ALTER TYPE "Marketplace" ADD VALUE 'gsshop';
