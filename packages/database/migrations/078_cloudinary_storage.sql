ALTER TABLE files DROP CONSTRAINT files_storage_provider_check;
ALTER TABLE files ADD CONSTRAINT files_storage_provider_check CHECK(storage_provider IN ('local','s3','cloudinary'));
