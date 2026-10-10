<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://ai.google.dev/static/site-assets/images/share-ais-513315318.png" />
</div>

# PIB Prelims 101: AI-Powered UPSC Article Analysis Platform

An intelligent platform that fetches, analyzes, and categorizes Press Information Bureau (PIB) articles for UPSC Civil Services Preliminary Examination preparation using Google Gemini AI.

## Features

### 🚀 Core Features
- **AI-Powered Article Analysis**: Automatically analyzes PIB articles for UPSC relevance using Gemini AI
- **GS Paper Classification**: Classifies articles into GS-1, GS-2, GS-3, or Current Events
- **Prelims Importance Scoring**: Rates articles 1-5 based on UPSC exam relevance
- **Smart Tagging**: Auto-generates relevant tags for search and filtering
- **Key Takeaways Extraction**: Extracts statutory basis, funding patterns, objectives, and beneficiaries

### ⚡ Automated Workflow
- **Scheduled Fetching**: Daily automatic article fetching at 2:00 AM UTC (7:30 AM IST)
- **AI Processing**: Automatic analysis of articles using Gemini AI
- **Database Integration**: Seamless storage in MongoDB via Prisma ORM
- **Real-time Updates**: Instant availability of processed articles in the UI

### 🛠️ Advanced Capabilities
- **CLI Tools**: Full command-line interface for manual control
- **API Endpoints**: REST API for integration and automation
- **Comprehensive Analytics**: Detailed statistics and reporting
- **Error Handling**: Robust error recovery and logging
- **Rate Limiting**: Built-in protection against API rate limits

## Quick Start

### Prerequisites
- Node.js 18+
- MongoDB database (local or Atlas)
- Google Gemini API key

### 1. Installation
```bash
# Clone and install dependencies
git clone <repository-url>
cd prelims101
npm install

# Set up environment variables
cp .env.example .env.local
# Edit .env.local with your credentials
```

### 2. Environment Configuration
Edit `.env.local`:
```env
# Required
GEMINI_API_KEY="your_gemini_api_key_here"
DATABASE_URL="mongodb+srv://username:password@cluster.mongodb.net/dbname?retryWrites=true&w=majority"

# Optional
PORT=3000
NODE_ENV=development
```

### 3. Database Setup
```bash
# Generate Prisma client
npm run prisma:generate

# Push schema to database
npm run prisma:push
```

### 4. Start the Application
```bash
# Development mode
npm run dev

# Production build
npm run build
npm run preview
```

## Article Fetching Service

### Using the Web Interface
1. Navigate to the application dashboard
2. Click "Fetch Articles" button
3. View real-time progress and results
4. New articles appear automatically in the article list

### Using CLI Commands
```bash
# Check environment configuration
npm run articles:check

# Run a test (dry run) without saving
npm run articles:dry-run

# Run full article fetching once
npm run articles:run

# Start scheduled service (runs daily at 2 AM UTC)
npm run cron:start

# Check service status
npm run articles:status
```

### API Endpoints
- `POST /api/articles/fetch` - Manually trigger article fetching
- `GET /api/articles/fetch/status` - Check service status
- `GET /api/articles/fetch/stats` - Get article statistics

## How It Works

### 1. Article Scraping
- Connects to PIB.gov.in homepage
- Scrapes article titles, ministries, dates, and summaries
- Extracts PIB IDs for tracking

### 2. AI Analysis
- Uses Gemini AI to analyze article content
- Classifies by GS paper (1, 2, 3, or Current Events)
- Assigns prelims importance score (1-5)
- Extracts key takeaways and trap alerts
- Links to previous year questions (PYQs)

### 3. Data Processing
- Converts raw data to structured format
- Adds UPSC-specific metadata
- Stores in MongoDB database
- Updates UI in real-time

### 4. Cron Scheduling
- Runs automatically every 24 hours
- Logs all operations to `/logs` directory
- Sends notifications on completion/failure
- Handles errors gracefully

## Project Structure
```
prelims101/
├── src/
│   ├── services/           # Core business logic
│   │   ├── pibScraper.ts      # PIB website scraping
│   │   ├── articleProcessor.ts # AI article processing
│   │   ├── databaseService.ts  # Database operations
│   │   ├── articleFetchingService.ts # Main orchestrator
│   │   ├── cronScheduler.ts    # Scheduled job management
│   │   └── simplePibFetcher.ts # Simplified fetcher
│   ├── components/         # React components
│   │   └── ArticleFetchButton.tsx # UI for fetching
│   ├── types/             # TypeScript types
│   └── data/              # Mock data
├── scripts/
│   └── fetchArticles.ts   # CLI entry point
├── prisma/
│   └── schema.prisma      # Database schema
├── server.ts              # Express server
└── logs/                  # Service logs (auto-generated)
```

## Configuration

### Environment Variables
| Variable | Required | Description |
|----------|----------|-------------|
| `GEMINI_API_KEY` | Yes | Google Gemini API key |
| `DATABASE_URL` | Yes | MongoDB connection string |
| `PORT` | No | Server port (default: 3000) |
| `NODE_ENV` | No | Environment (development/production) |
| `PIB_BASE_URL` | No | PIB website URL |
| `CRON_SCHEDULE` | No | Cron schedule (default: daily 2 AM UTC) |

### Rate Limiting
- Articles processed sequentially with 1-second delays
- Maximum 3 concurrent AI requests
- Automatic retry on failure
- Exponential backoff for rate limits

## Monitoring & Logging

### Log Files
- All operations logged to `/logs` directory
- Daily log files with timestamps
- JSON format for easy parsing
- Error tracking and debugging

### Notifications
- Success/failure notifications
- Detailed statistics reporting
- Email/Slack integration available
- Real-time status updates

## Troubleshooting

### Common Issues

1. **Gemini API Not Configured**
   ```
   Error: Gemini AI not configured
   ```
   **Solution**: Set `GEMINI_API_KEY` in `.env.local`

2. **Database Connection Failed**
   ```
   Error: Failed to connect to database
   ```
   **Solution**: Verify `DATABASE_URL` and network connectivity

3. **PIB Website Changes**
   ```
   Error: Failed to scrape PIB articles
   ```
   **Solution**: Update CSS selectors in `pibScraper.ts`

### Debugging
```bash
# Check environment
npm run articles:check

# Test without saving
npm run articles:dry-run

# View logs
ls -la logs/
tail -f logs/fetch-*.log
```

## Deployment

### Local Development
```bash
npm run dev
```

### Production Deployment
1. Set `NODE_ENV=production` in environment
2. Configure production database
3. Set up SSL certificates
4. Use process manager (PM2, systemd)
5. Configure monitoring and alerts

### Docker Deployment
```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
RUN npm run build
EXPOSE 3000
CMD ["npm", "start"]
```

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make changes with tests
4. Submit a pull request
5. Update documentation

## License

MIT License - see LICENSE file for details

## Support

For issues and questions:
1. Check troubleshooting section
2. Review logs in `/logs` directory
3. Open GitHub issue
4. Contact maintainers

---

**Note**: This service is designed for educational purposes. Always verify information from official sources before UPSC exam preparation.
