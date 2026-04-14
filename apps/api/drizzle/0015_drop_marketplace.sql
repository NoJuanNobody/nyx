-- Drop marketplace feature
-- Removes marketplace_listings and marketplace_reviews tables (and their enums)
-- as part of removing the marketplace feature from Nyx.

DROP TABLE IF EXISTS "marketplace_reviews";
DROP TABLE IF EXISTS "marketplace_listings";

DROP TYPE IF EXISTS "listing_type";
DROP TYPE IF EXISTS "listing_price_type";
