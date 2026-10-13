FROM node:22-alpine

WORKDIR /app

# ক্যাশিং সুবিধার জন্য ডিপেন্ডেন্সি ফাইল আগে কপি করা
COPY package*.json ./

# প্রোডাকশন ডিপেন্ডেন্সি ইনস্টলেশন
RUN npm install --omit=dev

# সোর্স কোড কপি করা
COPY server.js ./

# Render ডাইনামিক পোর্ট বাইন্ডিং সাপোর্ট
ENV PORT=3000
EXPOSE 3000

CMD ["npm", "start"]
