const { ApolloServer } = require('@apollo/server');
const { ApolloServerPluginLandingPageLocalDefault } = require('@apollo/server/plugin/landingPage/default');
const { makeExecutableSchema } = require('@graphql-tools/schema');
const { execute, subscribe } = require('graphql');
const { SubscriptionServer } = require('subscriptions-transport-ws');
const http = require('http');
const gql = require('graphql-tag');
const { GraphQLError } = require('graphql');
const { PubSub } = require('graphql-subscriptions');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { expressMiddleware } = require('@apollo/server/express4');

app.use(express.static('dist'))

const Book = require('./models/book');
const Author = require('./models/author');
const User = require('./models/user');

const JWT_SECRET = process.env.JWT_SECRET;

mongoose.set('strictQuery', false);
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('Connected to MongoDB'))
  .catch(err => console.error('MongoDB connection error:', err.message));

const pubsub = new PubSub();

const typeDefs = gql`
  # (Tus typeDefs igual que antes)
  type Mutation {
    addBook(
      title: String!
      published: Int!
      author: String!
      genres: [String!]!
    ): Book!

    editAuthor(
      name: String!  
      setBornTo: Int!
    ): Author

    createUser(
      username: String!
      favoriteGenre: String!
    ): User

    login(
      username: String!
      password: String!
    ): Token
  }

  type Subscription {
    bookAdded: Book!
  }

  type Author {
    name: String!
    id: ID!
    born: Int
    bookCount: Int!
  }

  type Book {
    title: String!
    published: Int!
    author: Author!
    id: ID!
    genres: [String!]!
  }

  type User {
    username: String!
    favoriteGenre: String!
    id: ID!
  }

  type Token {
    value: String!
  }

  type Query {
    me: User
    bookCount: Int!
    authorCount: Int!
    allBooks(author:String, genre: String): [Book!]!
    allAuthors: [Author!]!
  }
`;

const resolvers = {
  Mutation: {
    addBook: async (root, args, context) => {
      if (!context.currentUser) {
        throw new GraphQLError('not authenticated', {
          extensions: { code: 'UNAUTHENTICATED' },
        });
      }
      let author = await Author.findOne({ name: args.author });
      if (!author) {
        author = new Author({ name: args.author });
        await author.save();
      }
      const book = new Book({ ...args, author: author._id });
      await book.save();
      const populatedBook = await book.populate('author');
      pubsub.publish('BOOK_ADDED', { bookAdded: populatedBook });
      return populatedBook;
    },

    editAuthor: async (root, args, context) => {
      if (!context.currentUser) {
        throw new GraphQLError('not authenticated', {
          extensions: { code: 'UNAUTHENTICATED' },
        });
      }
      const author = await Author.findOne({ name: args.name });
      if (!author) return null;
      author.born = args.setBornTo;
      return author.save();
    },

    createUser: async (root, args) => {
      const user = new User({ ...args });
      return user.save();
    },

    login: async (root, args) => {
      const user = await User.findOne({ username: args.username });
      const passwordCorrect = args.password === 'secret';
      if (!user || !passwordCorrect) {
        throw new GraphQLError('wrong credentials', {
          extensions: { code: 'BAD_USER_INPUT' },
        });
      }
      const userForToken = {
        username: user.username,
        id: user._id,
      };
      return { value: jwt.sign(userForToken, JWT_SECRET) };
    }
  },

  Subscription: {
    bookAdded: {
      subscribe: () => pubsub.asyncIterator('BOOK_ADDED')
    }
  },

  Query: {
    me: (root, args, context) => context.currentUser,
    bookCount: async () => Book.countDocuments({}),
    authorCount: async () => Author.countDocuments({}),
    allBooks: async (root, args) => {
      const filter = {};
      if (args.author) {
        const author = await Author.findOne({ name: args.author });
        if (!author) return [];
        filter.author = author._id;
      }
      if (args.genre) filter.genres = { $in: [args.genre] };
      return Book.find(filter).populate('author');
    },
    allAuthors: async () => {
      
      return Author.aggregate([
        {
          $lookup: {
            from: 'books',
            localField: '_id',
            foreignField: 'author',
            as: 'books'
          }
        },
        {
          $addFields: {
            bookCount: { $size: '$books' }
          }
        },
        {
          $project: {
            books: 0
          }
        }
      ])
    }
  },

  //reomve to avoid n+1 problem
/*   Author: {
    bookCount: async (root) => {
      console.log('Resolviendo bookCount para', root.name)
      return Book.countDocuments({ author: root._id })
    }
  } */

};

const schema = makeExecutableSchema({ typeDefs, resolvers });

const server = new ApolloServer({
  schema,
  plugins: [ApolloServerPluginLandingPageLocalDefault()]
});

async function start() {
  await server.start();

  const app = express();
  app.use(cors());
  app.use(express.json());

  app.use('/graphql', (req, res, next) => {
    if (req.body === undefined) {
      req.body = {};
    }
    next();
  });

  app.use(
    '/graphql',
    expressMiddleware(server, {
      context: async ({ req }) => {
        const auth = req.headers.authorization;
        if (auth && auth.startsWith('Bearer ')) {
          const decodedToken = jwt.verify(auth.substring(7), JWT_SECRET);
          const currentUser = await User.findById(decodedToken.id);
          return { currentUser };
        }
        return {};
      }
    })
  );

  const httpServer = http.createServer(app);

  SubscriptionServer.create(
    {
      schema,
      execute,
      subscribe,
      onConnect: async (connectionParams) => {
        if (connectionParams.authorization) {
          const token = connectionParams.authorization.split(' ')[1];
          const decodedToken = jwt.verify(token, JWT_SECRET);
          const currentUser = await User.findById(decodedToken.id);
          return { currentUser };
        }
        return {};
      },
    },
    {
      server: httpServer,
      path: '/graphql',
    }
  );

  httpServer.listen(4000, () => {
    console.log('🚀 Server running at http://localhost:4000/graphql');
  });
}

start();
