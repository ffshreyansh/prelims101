import { PrismaClient } from '@prisma/client';
import { PIBArticle } from '../types/index.ts';

export class DatabaseService {
  private prisma: PrismaClient;

  constructor() {
    this.prisma = new PrismaClient();
  }

  /**
   * Save or update articles in the database
   */
  async saveArticles(articles: Partial<PIBArticle>[]): Promise<{ saved: number; updated: number; skipped: number }> {
    let saved = 0;
    let updated = 0;
    let skipped = 0;

    for (const article of articles) {
      try {
        if (!article.pibId) {
          console.warn('Article missing pibId, skipping:', article.title);
          skipped++;
          continue;
        }

        // Check if article already exists
        const existing = await this.prisma.article.findUnique({
          where: { slugId: article.pibId }
        });

        if (existing) {
          // Update existing article
          await this.prisma.article.update({
            where: { id: existing.id },
            data: this.mapToPrismaModel(article, false)
          });
          updated++;
          console.log(`Updated article: ${article.title}`);
        } else {
          // Create new article
          await this.prisma.article.create({
            data: this.mapToPrismaModel(article, true)
          });
          saved++;
          console.log(`Saved new article: ${article.title}`);
        }

      } catch (error) {
        console.error(`Error saving article "${article.title}":`, error);
        skipped++;
      }
    }

    return { saved, updated, skipped };
  }

  /**
   * Map PIBArticle to Prisma Article model
   */
  private mapToPrismaModel(article: Partial<PIBArticle>, isNew: boolean): any {
    // Generate slug ID if not provided
    const slugId = article.pibId || 
      article.title?.toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .substring(0, 100) || 
      `pib-${Date.now()}`;

    const gsPaper = article.gsPaper || 'Current Events';
    
    // Extract key takeaways to string arrays for Prisma
    const keyPointers = article.keyTakeaways?.keyPointers || [];
    const objectives = article.keyTakeaways?.objectives || [];
    
    // Combine all pointers and objectives for summary
    const summaryBullets = [
      ...(article.summaryBullets || []),
      ...keyPointers,
      ...objectives
    ].slice(0, 10); // Limit to 10 items

    // Create Prisma model data
    const data: any = {
      slugId,
      title: article.title || 'Untitled Article',
      ministry: article.ministry || 'Unknown Ministry',
      date: article.date || new Date().toISOString().split('T')[0],
      pibId: article.pibId || slugId,
      gsPaper,
      topic: article.topic || 'General Studies',
      prelimsImportance: article.prelimsImportance || 3,
      tags: article.tags || [],
      summaryBullets,
      statutoryOrConstitutional: article.keyTakeaways?.statutoryOrConstitutional || null,
      nodalMinistryOrAgency: article.keyTakeaways?.nodalMinistryOrAgency || article.ministry || null,
      fundingPattern: article.keyTakeaways?.fundingPattern || null,
      objectives,
      eligibleBeneficiaries: article.keyTakeaways?.eligibleBeneficiaries || null,
      keyPointers,
      pyqYear: article.pyqYear || null,
      pyqTopic: article.pyqContext || null,
      staticBookReference: article.staticStudyBox?.standardBook || null,
      staticChapterTopic: article.staticStudyBox?.chapterTopic || null,
      staticWhatToRead: article.staticStudyBox?.whatToRead || null,
      staticCoreArticlesOrActs: article.staticStudyBox?.coreArticlesOrActs || [],
      syllabusSubject: article.staticSyllabusLinkage?.subject || gsPaper,
      syllabusArticleOrAct: article.staticSyllabusLinkage?.articleOrAct || null,
      syllabusRelatedConcepts: article.staticSyllabusLinkage?.relatedConcepts || [],
      prelimsTrapAlert: article.prelimsTrapAlert || 'No specific traps identified',
      fullContent: article.fullContent || null,
      officialUrl: article.officialUrl || null
    };

    // Only set createdAt for new articles
    if (isNew) {
      data.createdAt = new Date();
    }

    return data;
  }

  /**
   * Get all existing PIB IDs from database
   */
  async getExistingPIBIds(): Promise<string[]> {
    try {
      const articles = await this.prisma.article.findMany({
        select: { pibId: true }
      });
      return articles.map(article => article.pibId).filter(Boolean);
    } catch (error) {
      console.error('Error fetching existing PIB IDs:', error);
      return [];
    }
  }

  /**
   * Filter out articles that already exist in database
   */
  async filterNewArticles(scrapedArticles: Array<{ pibId: string }>): Promise<Array<{ pibId: string }>> {
    const existingIds = await this.getExistingPIBIds();
    return scrapedArticles.filter(article => !existingIds.includes(article.pibId));
  }

  /**
   * Get count of articles in database
   */
  async getArticleCount(): Promise<number> {
    try {
      return await this.prisma.article.count();
    } catch (error) {
      console.error('Error counting articles:', error);
      return 0;
    }
  }

  /**
   * Close database connection
   */
  async disconnect(): Promise<void> {
    await this.prisma.$disconnect();
  }
}

export default DatabaseService;