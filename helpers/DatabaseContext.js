import pool from "../db.js";
import fs from "fs";

/**
 * Generates a comprehensive database context JSON file
 * containing all tables, columns, relationships, and constraints
 */
export async function generateDatabaseContext() {
    try {
        // Get database name from connection
        const [dbInfo] = await pool.query('SELECT DATABASE() as db_name');
        const databaseName = dbInfo[0].db_name;

        const context = {
            generatedAt: new Date().toISOString(),
            database: {
                name: databaseName
            },
            tables: {}
        };

        // Get all tables
        const [tables] = await pool.query(`
            SELECT TABLE_NAME, TABLE_COMMENT
            FROM information_schema.TABLES
            WHERE TABLE_SCHEMA = ?
            ORDER BY TABLE_NAME
        `, [databaseName]);

        // Process each table
        for (const table of tables) {
            const tableName = table.TABLE_NAME;

            // Get columns
            const [columns] = await pool.query(`
                SELECT 
                    COLUMN_NAME,
                    DATA_TYPE,
                    COLUMN_TYPE,
                    IS_NULLABLE,
                    COLUMN_DEFAULT,
                    COLUMN_KEY,
                    EXTRA,
                    COLUMN_COMMENT,
                    CHARACTER_MAXIMUM_LENGTH,
                    NUMERIC_PRECISION,
                    NUMERIC_SCALE
                FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
                ORDER BY ORDINAL_POSITION
            `, [databaseName, tableName]);

            // Get primary keys
            const [primaryKeys] = await pool.query(`
                SELECT COLUMN_NAME
                FROM information_schema.KEY_COLUMN_USAGE
                WHERE TABLE_SCHEMA = ? 
                    AND TABLE_NAME = ? 
                    AND CONSTRAINT_NAME = 'PRIMARY'
                ORDER BY ORDINAL_POSITION
            `, [databaseName, tableName]);

            // Get foreign keys
            const [foreignKeys] = await pool.query(`
                SELECT 
                    COLUMN_NAME,
                    REFERENCED_TABLE_NAME,
                    REFERENCED_COLUMN_NAME,
                    CONSTRAINT_NAME
                FROM information_schema.KEY_COLUMN_USAGE
                WHERE TABLE_SCHEMA = ? 
                    AND TABLE_NAME = ? 
                    AND REFERENCED_TABLE_NAME IS NOT NULL
                ORDER BY COLUMN_NAME
            `, [databaseName, tableName]);

            // Get indexes
            const [indexes] = await pool.query(`
                SELECT 
                    INDEX_NAME,
                    COLUMN_NAME,
                    NON_UNIQUE,
                    SEQ_IN_INDEX
                FROM information_schema.STATISTICS
                WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
                ORDER BY INDEX_NAME, SEQ_IN_INDEX
            `, [databaseName, tableName]);

            // Format columns
            const formattedColumns = columns.map(col => ({
                name: col.COLUMN_NAME,
                type: col.DATA_TYPE,
                fullType: col.COLUMN_TYPE,
                nullable: col.IS_NULLABLE === 'YES',
                default: col.COLUMN_DEFAULT,
                key: col.COLUMN_KEY,
                extra: col.EXTRA,
                comment: col.COLUMN_COMMENT || '',
                maxLength: col.CHARACTER_MAXIMUM_LENGTH,
                precision: col.NUMERIC_PRECISION,
                scale: col.NUMERIC_SCALE
            }));

            // Format primary keys
            const formattedPrimaryKeys = primaryKeys.map(pk => pk.COLUMN_NAME);

            // Format foreign keys
            const formattedForeignKeys = foreignKeys.map(fk => ({
                column: fk.COLUMN_NAME,
                referencesTable: fk.REFERENCED_TABLE_NAME,
                referencesColumn: fk.REFERENCED_COLUMN_NAME,
                constraintName: fk.CONSTRAINT_NAME
            }));

            // Format indexes (group by index name)
            const indexMap = {};
            indexes.forEach(idx => {
                if (!indexMap[idx.INDEX_NAME]) {
                    indexMap[idx.INDEX_NAME] = {
                        name: idx.INDEX_NAME,
                        unique: idx.NON_UNIQUE === 0,
                        columns: []
                    };
                }
                indexMap[idx.INDEX_NAME].columns.push(idx.COLUMN_NAME);
            });
            const formattedIndexes = Object.values(indexMap);

            // Build table structure
            context.tables[tableName] = {
                comment: table.TABLE_COMMENT || '',
                columns: formattedColumns,
                primaryKeys: formattedPrimaryKeys,
                foreignKeys: formattedForeignKeys,
                indexes: formattedIndexes
            };
        }

        // Save to file
        const outputPath = './database-context.json';
        fs.writeFileSync(outputPath, JSON.stringify(context, null, 2), 'utf8');

        return { success: true, path: outputPath, tableCount: Object.keys(context.tables).length };
    } catch (error) {
        console.error('❌ Error generating database context:', error.message);
        return { success: false, error: error.message };
    }
}