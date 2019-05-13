const { MongoClient, ObjectId} = require('mongodb');
const mongoose = require('mongoose');
const Client = require('instagram-private-api').V1;
const { IncomingForm } = require('formidable');
const { rename, unlinkSync } = require('fs');
const msm = require('mongo-scheduler-more');
const express = require('express');
const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const sendMail = require('./sendMail');
const withAuth = require('./withAuth');
const User = require('./models/User');


const PORT = process.env.PORT || 3000;
const SECRET = process.env.SECRET || 'yHSHGuYkD4YMryOU1mJUId4zUihMNg';
const PROXY = process.env.PROXY;

const app = express();
const whitelist = ['http://localhost:3001', 'https://dash.h2ecommerce.de']
const corsOptions = {
  origin: (origin, callback) => {
    if (whitelist.indexOf(origin) !== -1) {
      callback(null, true);
    } else if (origin === undefined) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  optionsSuccessStatus: 200
};

const connection = process.env.NODE_ENV === 'production'
  ? 'mongodb://3.121.177.95:27017/instagram-schedule' 
  : 'mongodb://localhost:27017/instagram-schedule';
const driverOptions = process.env.NODE_ENV === 'production'
  ? {
      useNewUrlParser: true,
      auth: {
        user: 'instagramScheduleUser',
        password: 'DhhkDddL3UwFIAeizAXC0lkeezzKbK0T31w6TE'
      }
    }
  : { useNewUrlParser: true };
let ready = false;
let db = null;

MongoClient.connect(connection, driverOptions, (err, client) => {
  if (err) {
    throw err;
  }
  db = client.db('instagram-schedule');
  ready = true;
});

mongoose.connect(connection, driverOptions, (err) => {
  if (err) throw err;
});

const scheduler = new msm(connection, driverOptions);

const passwords = {
  h2ecommerce: '123Jens456',
  nureinberg: 'gauche-turbid-red',
  biobalancegermany: 'fragment-mufti-plow'
};
const device = new Client.Device('iphone');


const postImage = data => {
  const {
    account,
    imageUrl,
    caption
  } = data;

  const password = passwords[account];
  const storage = new Client.CookieFileStorage(`${__dirname}/../cookies/${account}.json`);

  Client.Session.create(device, storage, account, password)
    .then(session => {
      if (typeof(PROXY) === String) Client.Request.setProxy(PROXY);
      // Now you have a session, we can follow / unfollow, anything...
      return [session, Client.Upload.photo(session, imageUrl)
        .then(upload => {
          // upload instanceof Client.Upload
          // nothing more than just keeping upload id
          // console.log(upload.params.uploadId);
          return Client.Media.configurePhoto(session, upload.params.uploadId, caption);
        })
        .then(medium => {
          // we configure medium, it is now visible with caption
          console.log(`Posted to account ${medium.params.user.username} with link ${medium.params.webLink}!`);
          unlinkSync(imageUrl);
        })
        .catch(async error => {
          console.error(error);
          await sendMail(error, data).catch(console.error);
          unlinkSync(imageUrl);
        })]
    })
    .catch(async error => {
      console.error(error);
      await sendMail(error, data).catch(console.error);
      unlinkSync(imageUrl);
    });
};

app.use(cors(corsOptions));
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
app.use(cookieParser());

app.post('/', (req, res) => {
  const form = new IncomingForm();
  let data = {};

  form.parse(req);

  form.on('file', (field, file) => {
    const fileName = `${Date.now()}-${(file.name).replace(/[^a-zA-Z0-9.]/g, "")}`;
    const imageUrl = `${__dirname}/../uploads/${fileName}`;

    rename(file.path, imageUrl, (err) => {
      if (err) throw err;
    });

    data = {
      ...data,
      'imageUrl': imageUrl,
      'fileName': fileName
    };
  });

  form.on('field', (field, value) => {
    data = {
      ...data,
      [field]: value,
    };
  });

  form.on('end', () => {
    const event = {
      name: 'instagram-post',
      id: String(Date.now()),
      after: new Date(Number(data.uploadDate)),
      data: data,
    };

    scheduler.schedule(event);
    console.log(`Scheduled to account ${data.account}.`);
    res.sendStatus(200);
  });
});

app.post('/list', (req, res) => {
  const filter = req.query.account 
    ? { 'data.account' : req.query.account } 
    : {};

  scheduler.list({ bySchedule: true, filter }, (err, events) => {
    if (err) {
      console.error(err);
      res.sendStatus(500);
    }
    res.send(events).status(200);
  });
});

app.post('/remove', async (req, res) => {
  const { id } = req.query;
  
  const getFilePath = id => {
    const collection = db.collection('scheduled_events');

    if (ready && id) {
      return new Promise((resolve, reject) => {
        collection.find({ _id: ObjectId(id) }).toArray((err, items) => {
          if (err) {
            console.error(err);
            reject(err);
          }
          resolve(items[0].data.imageUrl);
        });
      });
    }
  };

  if (id) {
    const params = {
      name: 'instagram-post',
      id: id
    };
    const filePath = await getFilePath(id);

    scheduler.remove(params, (err, event) => {
      if (err) {
        console.error(err);
        res.sendStatus(500);
      }
      res.send(event.result).status(200);
      console.log(event.result);
    });
    unlinkSync(filePath);
  } else {
    res.send('Nothing specified to delete!').status(200);
  }
});

app.post('/authenticate', (req, res) => {
  const { email, password } = req.body;
  User.findOne({ email }, (err, user) => {
    if (err) {
      console.error(err);
      res.status(500)
        .json({
          error: 'Internal error please try again'
        });
    } else if (!user) {
      res.status(401)
        .json({
          error: 'Incorrect email or password'
        });
    } else {
      user.isCorrectPassword(password, (err, same) => {
        if (err) {
          res.status(500)
            .json({
              error: 'Internal error please try again'
            });
        } else if (!same) {
          res.status(401)
            .json({
              error: 'Incorrect email or password'
            });
        } else {
          // Issue token
          const payload = { email };
          const token = jwt.sign(payload, SECRET, {
            expiresIn: '1h'
          });
          res.cookie('token', token, { httpOnly: false }).sendStatus(200);
        }
      });
    }
  });
});

app.post('/register', (req, res) => {
  const { email, password } = req.body;
  const user = new User({ email, password });
  user.save((err) => {
    if (err) {
      console.log(err);
      res.status(500).send("Error registering new user please try again.");
    } else {
      res.status(200).send("Welcome to the club!");
    }
  });
});

app.post('/checkToken', withAuth, (req, res) => {
  res.sendStatus(200);
});

app.post('/addAccount', async (req, res) => {
  const { 
    accountEmail, 
    instagramUsername, 
    instagramPassword 
  } = req.body;

  const doc = await User.findOne({ email: accountEmail });
  
  /* const query = doc.updateOne(
    { _id: doc._id },
    { '$set': { test: instagramUsername } }
  ); */
  const query = User.updateOne({ _id: doc._id }, { test: instagramUsername });

  res.send(query).status(200);
})

app.use('/uploads', express.static(`${__dirname}/../uploads`));

app.listen(PORT, () => {
  console.log(
    `App listening on port ${PORT} runnung in ${process.env.NODE_ENV ? process.env.NODE_ENV : 'dev'}!`
  );
});

scheduler.on('instagram-post', event => {
  postImage(event.data);
});
